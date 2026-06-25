/**
 * Single-row delivery orchestration (per 03-delivery section 3, basic design section 8.2).
 *
 * Resolves the destination/key, signs, POSTs, records the ledger, and applies the state
 * transition for one claimed row. {@link deliverOne} is strictly fail-open: it never throws, so
 * a delivery-side failure cannot stop the dispatcher loop or reach the user's business path.
 */
import { sign, backoffMs, onSuccess, onFailure } from "../core/index";
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

export interface DeliverDeps {
  store: Store;
  http: ReturnType<typeof createHttpClient>;
  config: RelayConfig;
  clock: Clock;
  hooks?: DeliveryHooks;
}

interface Ctx {
  row: OutboxRow;
  deps: DeliverDeps;
  now: Date;
}

type Resolved = { ok: true; url: string; secret: string } | { ok: false; error: string };

/** Only a 2xx response is a success; everything else (including no response) is a retry. */
function isSuccess(status: number | null): boolean {
  return status !== null && status >= 200 && status < 300;
}

/** Resolve the destination URL and signing secret for a row (registered endpoint or inline). */
async function resolveTarget(row: OutboxRow, store: Store): Promise<Resolved> {
  if (row.endpointId != null) {
    const ep = await store.findEndpoint(row.endpointId);
    if (!ep) return { ok: false, error: "ENDPOINT_NOT_FOUND" };
    if (ep.status === "disabled") return { ok: false, error: "ENDPOINT_DISABLED" };
    return { ok: true, url: ep.url, secret: ep.secret };
  }
  if (row.targetUrl != null) {
    if (row.secretSnapshot == null) return { ok: false, error: "MISSING_SECRET" };
    return { ok: true, url: row.targetUrl, secret: row.secretSnapshot };
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
    status,
    error,
    durationMs,
  };
}

/** Invoke a delivery hook fail-open: a hook error is logged and swallowed, never propagated. */
async function fireHook(
  ctx: Ctx,
  hook: ((event: DeliveryEvent) => void | Promise<void>) | undefined,
  event: DeliveryEvent,
): Promise<void> {
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
  await ctx.deps.store.completeAttempt(attempt, onSuccess(ctx.now));
  await fireHook(ctx, ctx.deps.hooks?.onDelivered, event);
}

/**
 * Failure: write the ledger row and schedule the next retry or move to `dead` in one round trip
 * (guarded on `status = 'in_flight'`), then notify onRetry/onDead.
 */
async function applyFailure(
  ctx: Ctx,
  attempt: NewDeliveryAttempt,
  summary: string,
  event: DeliveryEvent,
): Promise<void> {
  const { row, deps, now } = ctx;
  const dead = row.attempts + 1 >= deps.config.retry.maxAttempts;
  const backoff = backoffMs(row.attempts + 1, deps.config.retry);
  await deps.store.completeAttempt(
    attempt,
    onFailure(row, deps.config.retry, now, summary, backoff),
  );
  await fireHook(ctx, dead ? deps.hooks?.onDead : deps.hooks?.onRetry, event);
}

/** Run the POST, then write the ledger row and apply the success/failure transition in one round trip. */
async function deliverHttp(ctx: Ctx, url: string, secret: string): Promise<void> {
  const { row, now } = ctx;
  const body = JSON.stringify(row.payload);
  const sig = await sign({
    id: row.id,
    timestampSec: Math.floor(now.getTime() / 1000),
    body,
    secret,
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
  await (success
    ? applySuccess(ctx, attempt, eventFor(ctx, res.status, null, res.durationMs))
    : applyFailure(ctx, attempt, failure, eventFor(ctx, res.status, failure, res.durationMs)));
}

/**
 * Deliver one claimed row, writing the ledger and applying the transition. Never throws: a
 * delivery-side failure is logged and persisted as a retryable failure (fail-open, section 4).
 *
 * The ledger write and the transition are a single atomic `completeAttempt`, so a failure leaves
 * neither written — exactly one ledger row is produced per invocation with no partial state.
 */
export async function deliverOne(row: OutboxRow, deps: DeliverDeps): Promise<void> {
  const ctx: Ctx = { row, deps, now: deps.clock() };
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
    await deliverHttp(ctx, resolved.url, resolved.secret);
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
  }
}
