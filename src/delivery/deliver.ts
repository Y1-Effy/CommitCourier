/**
 * Single-row delivery orchestration (per 03-delivery section 3, basic design section 8.2).
 *
 * Resolves the destination/key, signs, POSTs, records the ledger, and applies the state
 * transition for one claimed row. {@link deliverOne} is strictly fail-open: it never throws, so
 * a delivery-side failure cannot stop the dispatcher loop or reach the user's business path.
 */
import {
  sign,
  backoffMs,
  parseRetryAfter,
  onSuccess,
  onFailure,
  onPermanentFailure,
} from "../core/index";
import type { OutboxRow, RelayConfig, Clock, SignatureHeaders } from "../core/index";
import type { Store, NewDeliveryAttempt } from "../store/store";
import type { createHttpClient } from "./http";
import { secretFreeSummary } from "./_error";

/** A single delivery outcome reported to {@link DeliveryHooks}. Carries no secret. */
export interface DeliveryEvent {
  /** Outbox row id (also the signature `webhook-id`). */
  id: string;
  eventType: string;
  /** 1-based attempt number this outcome corresponds to. */
  attempt: number;
  /** Registered endpoint id, or null for an inline `{ url, secret }` destination. */
  endpointId: string | null;
  /** Destination host only (no path/query/secret), or null when not resolved (e.g. bad target). */
  host: string | null;
  /** HTTP status, or null when no response was received (network/timeout/SSRF/pre-HTTP failure). */
  status: number | null;
  /** Secret-free failure summary, or null on success. */
  error: string | null;
  /** Wall-clock duration of the HTTP attempt in ms (0 for pre-HTTP failures). */
  durationMs: number;
}

/**
 * Optional, fail-open delivery-outcome callbacks. Exactly one fires per delivery attempt; an
 * exception thrown by a hook is logged and swallowed so it cannot stall the dispatcher loop.
 */
export interface DeliveryHooks {
  /** A 2xx response moved the row to `delivered`. */
  onDelivered?: (event: DeliveryEvent) => void | Promise<void>;
  /** The attempt failed but more remain; the row is back to `pending` with a backoff. */
  onRetry?: (event: DeliveryEvent) => void | Promise<void>;
  /** The attempt failed and exhausted `maxAttempts`; the row moved to `dead`. */
  onDead?: (event: DeliveryEvent) => void | Promise<void>;
}

/** Secret-free context for the start of a delivery attempt, passed to a {@link DeliveryInstrument}. */
export interface DeliveryStart {
  /** Outbox row id (also the signature `webhook-id`). */
  id: string;
  eventType: string;
  /** 1-based attempt number. */
  attempt: number;
  endpointId: string | null;
  /** Destination host if already known (inline rows), else null (registered endpoint, resolved later). */
  host: string | null;
}

/**
 * Optional, fail-open instrumentation seam for tracing/metrics (the OpenTelemetry seam). Called once
 * just before a delivery attempt with secret-free start info; the returned finaliser, if any, is
 * called exactly once with the terminal {@link DeliveryEvent}. Designed so an implementation can
 * start a span on call and end it in the finaliser. Both the factory and the finaliser are wrapped
 * fail-open: a throw is logged and swallowed so it cannot stall the dispatcher loop.
 */
export type DeliveryInstrument = (
  start: DeliveryStart,
) => ((event: DeliveryEvent) => void) | undefined;

export interface DeliverDeps {
  store: Store;
  http: ReturnType<typeof createHttpClient>;
  config: RelayConfig;
  clock: Clock;
  hooks?: DeliveryHooks;
  /** Optional tracing/metrics seam; see {@link DeliveryInstrument}. */
  instrument?: DeliveryInstrument;
}

interface Ctx {
  row: OutboxRow;
  deps: DeliverDeps;
  now: Date;
  /** Resolved destination host (no path/secret), refined once the target URL is known. */
  host: string | null;
  /** Instrumentation finaliser for this delivery (from `deps.instrument`), or null. Called once. */
  finish: ((event: DeliveryEvent) => void) | null;
  /** One-shot guard so the instrumentation finaliser runs exactly once. */
  settled: { done: boolean };
}

/** Parse the host from a URL without throwing (returns null on a malformed/absent URL). */
function hostOf(url: string | null): string | null {
  if (url == null) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

type Resolved = { ok: true; url: string; secrets: string[] } | { ok: false; error: string };

/** Only a 2xx response is a success; everything else (including no response) is a retry. */
function isSuccess(status: number | null): boolean {
  return status !== null && status >= 200 && status < 300;
}

/**
 * A permanent failure stops retries immediately. Only `410 Gone` qualifies in v1.1: the receiver is
 * telling us the destination no longer exists, so retrying wastes attempts and a registered endpoint
 * should be disabled.
 */
function isPermanentFailure(status: number | null): boolean {
  return status === 410;
}

/** Resolve the destination URL and signing secret for a row (registered endpoint or inline). */
async function resolveTarget(row: OutboxRow, store: Store): Promise<Resolved> {
  if (row.endpointId != null) {
    const ep = await store.findEndpoint(row.endpointId);
    if (!ep) return { ok: false, error: "ENDPOINT_NOT_FOUND" };
    if (ep.status === "disabled") return { ok: false, error: "ENDPOINT_DISABLED" };
    // Dual-sign with the secondary key too during a rotation window (current key first).
    const secrets = ep.secretSecondary == null ? [ep.secret] : [ep.secret, ep.secretSecondary];
    return { ok: true, url: ep.url, secrets };
  }
  if (row.targetUrl != null) {
    if (row.secretSnapshot == null) return { ok: false, error: "MISSING_SECRET" };
    return { ok: true, url: row.targetUrl, secrets: [row.secretSnapshot] };
  }
  return { ok: false, error: "ENQUEUE_NO_TARGET" };
}

/** Signature headers plus content-type and the optional idempotency key (never the secret). */
function buildHeaders(sig: SignatureHeaders, row: OutboxRow): Record<string, string> {
  const headers: Record<string, string> = { ...sig, "content-type": "application/json" };
  if (row.idempotencyKey != null) headers["idempotency-key"] = row.idempotencyKey;
  return headers;
}

/** A ledger row for a failure that never reached HTTP (e.g. endpoint missing, signing error). */
function noHttpAttempt(row: OutboxRow, error: string): NewDeliveryAttempt {
  return {
    outboxId: row.id,
    attemptNo: row.attempts + 1,
    requestHeaders: {},
    responseStatus: null,
    responseBodySnippet: null,
    durationMs: 0,
    error,
  };
}

/** Build the secret-free {@link DeliveryEvent} for this attempt. */
function eventFor(
  ctx: Ctx,
  status: number | null,
  error: string | null,
  durationMs: number,
): DeliveryEvent {
  return {
    id: ctx.row.id,
    eventType: ctx.row.eventType,
    attempt: ctx.row.attempts + 1,
    endpointId: ctx.row.endpointId,
    host: ctx.host,
    status,
    error,
    durationMs,
  };
}

/**
 * Finalise the instrumentation seam exactly once with the terminal event (fail-open). A finaliser
 * error is logged and swallowed so it cannot stall the dispatcher loop.
 */
function settle(ctx: Ctx, event: DeliveryEvent): void {
  if (ctx.settled.done) return;
  ctx.settled.done = true;
  if (!ctx.finish) return;
  try {
    ctx.finish(event);
  } catch (err) {
    ctx.deps.config.logger.error("delivery instrumentation failed", {
      id: ctx.row.id,
      error: secretFreeSummary(err),
    });
  }
}

/**
 * Invoke a delivery hook fail-open: a hook error is logged and swallowed, never propagated. Also
 * finalises the instrumentation seam with this terminal `event` — `fireHook` is reached exactly once
 * per delivery on every normal path, so the span/metric is settled with the real outcome here.
 */
async function fireHook(
  ctx: Ctx,
  hook: ((event: DeliveryEvent) => void | Promise<void>) | undefined,
  event: DeliveryEvent,
): Promise<void> {
  settle(ctx, event);
  if (!hook) return;
  try {
    await hook(event);
  } catch (err) {
    ctx.deps.config.logger.error("delivery hook failed", {
      id: ctx.row.id,
      error: secretFreeSummary(err),
    });
  }
}

/**
 * Success: write the ledger row and move to `delivered` in one round trip (store guards on
 * `status = 'in_flight'`), then notify onDelivered.
 */
async function applySuccess(
  ctx: Ctx,
  attempt: NewDeliveryAttempt,
  event: DeliveryEvent,
): Promise<void> {
  await ctx.deps.store.completeAttempt(attempt, onSuccess(ctx.now), ctx.row.lockedBy);
  await fireHook(ctx, ctx.deps.hooks?.onDelivered, event);
}

/**
 * Failure: write the ledger row and schedule the next retry or move to `dead` in one round trip
 * (guarded on `status = 'in_flight'`), then notify onRetry/onDead.
 */
// eslint-disable-next-line max-params -- one optional Retry-After hint kept inline with the failure path
async function applyFailure(
  ctx: Ctx,
  attempt: NewDeliveryAttempt,
  summary: string,
  event: DeliveryEvent,
  retryAfterMs?: number | null,
): Promise<void> {
  const { row, deps, now } = ctx;
  const { retry } = deps.config;
  const dead = row.attempts + 1 >= retry.maxAttempts;
  // Honour a server-sent Retry-After when it exceeds our own backoff, clamped to retry.capMs so a
  // hostile/buggy header cannot park a row indefinitely.
  const base = backoffMs(row.attempts + 1, retry);
  const backoff = Math.min(Math.max(base, retryAfterMs ?? 0), retry.capMs);
  await deps.store.completeAttempt(
    attempt,
    onFailure(row, retry, now, summary, backoff),
    row.lockedBy,
  );
  await fireHook(ctx, dead ? deps.hooks?.onDead : deps.hooks?.onRetry, event);
}

/**
 * Permanent failure (HTTP 410 Gone): write the ledger row and move straight to `dead` without
 * consuming the retry budget, disable the registered endpoint (fail-open — a disable error is logged,
 * never propagated), then notify onDead.
 */
async function applyPermanentFailure(
  ctx: Ctx,
  attempt: NewDeliveryAttempt,
  summary: string,
  event: DeliveryEvent,
): Promise<void> {
  const { row, deps, now } = ctx;
  await deps.store.completeAttempt(attempt, onPermanentFailure(row, summary), row.lockedBy);
  if (row.endpointId != null) {
    try {
      await deps.store.disableEndpoint(row.endpointId, now);
    } catch (err) {
      deps.config.logger.error("disableEndpoint on 410 failed", {
        id: row.id,
        endpointId: row.endpointId,
        error: secretFreeSummary(err),
      });
    }
  }
  await fireHook(ctx, deps.hooks?.onDead, event);
}

/** Run the POST, then write the ledger row and apply the success/failure transition in one round trip. */
async function deliverHttp(ctx: Ctx, url: string, secrets: string[]): Promise<void> {
  const { row, now } = ctx;
  // Refine the instrumentation host now that the destination is resolved (registered endpoints
  // only have their URL after findEndpoint).
  ctx.host = hostOf(url);
  const body = JSON.stringify(row.payload);
  const sig = await sign({
    id: row.id,
    timestampSec: Math.floor(now.getTime() / 1000),
    body,
    secrets,
  });
  const headers = buildHeaders(sig, row);
  const res = await ctx.deps.http.post({ url, headers, body });
  const success = isSuccess(res.status);
  const failure = res.error ?? `HTTP ${String(res.status)}`;
  const attempt: NewDeliveryAttempt = {
    outboxId: row.id,
    attemptNo: row.attempts + 1,
    requestHeaders: headers,
    responseStatus: res.status,
    responseBodySnippet: res.bodySnippet,
    durationMs: res.durationMs,
    error: success ? null : failure,
  };
  if (success) {
    await applySuccess(ctx, attempt, eventFor(ctx, res.status, null, res.durationMs));
    return;
  }
  const event = eventFor(ctx, res.status, failure, res.durationMs);
  if (isPermanentFailure(res.status)) {
    await applyPermanentFailure(ctx, attempt, failure, event);
    return;
  }
  const retryAfterMs = parseRetryAfter(res.retryAfter, now.getTime());
  await applyFailure(ctx, attempt, failure, event, retryAfterMs);
}

/**
 * Deliver one claimed row, writing the ledger and applying the transition. Never throws: a
 * delivery-side failure is logged and persisted as a retryable failure (fail-open, section 4).
 *
 * The ledger write and the transition are a single atomic `completeAttempt`, so a failure leaves
 * neither written — exactly one ledger row is produced per invocation with no partial state.
 */
export async function deliverOne(row: OutboxRow, deps: DeliverDeps): Promise<void> {
  const host = hostOf(row.targetUrl);
  let finish: ((event: DeliveryEvent) => void) | null = null;
  if (deps.instrument) {
    try {
      finish =
        deps.instrument({
          id: row.id,
          eventType: row.eventType,
          attempt: row.attempts + 1,
          endpointId: row.endpointId,
          host,
        }) ?? null;
    } catch (err) {
      deps.config.logger.error("delivery instrument start failed", {
        id: row.id,
        error: secretFreeSummary(err),
      });
    }
  }
  const ctx: Ctx = { row, deps, now: deps.clock(), host, finish, settled: { done: false } };
  try {
    const resolved = await resolveTarget(row, deps.store);
    if (!resolved.ok) {
      await applyFailure(
        ctx,
        noHttpAttempt(row, resolved.error),
        resolved.error,
        eventFor(ctx, null, resolved.error, 0),
      );
      return;
    }
    await deliverHttp(ctx, resolved.url, resolved.secrets);
  } catch (err) {
    const summary = secretFreeSummary(err);
    deps.config.logger.error("deliverOne failed", { id: row.id, error: summary });
    try {
      await applyFailure(
        ctx,
        noHttpAttempt(row, summary),
        summary,
        eventFor(ctx, null, summary, 0),
      );
    } catch (inner) {
      // Even the failover write failed; swallow so the dispatcher loop keeps running.
      deps.config.logger.error("deliverOne failover record failed", {
        id: row.id,
        error: secretFreeSummary(inner),
      });
    }
  } finally {
    // Safety net: every normal path settles via fireHook; only an unrecoverable double-write failure
    // reaches here unsettled. Finalise so an instrumentation span is never leaked.
    settle(ctx, eventFor(ctx, null, "delivery did not settle", 0));
  }
}
