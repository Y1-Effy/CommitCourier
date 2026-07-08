/**
 * Single-row delivery orchestration.
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
  RelayError,
} from "../core/index";
import type { OutboxRow, RelayConfig, Clock, SignatureHeaders } from "../core/index";
import type { DispatchStore, EndpointStore, NewDeliveryAttempt } from "../store/store";
import type { createHttpClient } from "./http";
import type { Sink, SinkResult } from "../forward/index";
import { secretFreeSummary } from "./_error";
import { createCriticalLogger } from "./critical";
import type { CriticalLogger } from "./critical";

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
 * Optional, fail-open delivery-outcome callbacks, each passed a secret-free {@link DeliveryEvent}
 * (never the payload or signing secret). Contract:
 *
 * - A hook fires only when the row's state transition actually committed. A worker that lost its
 *   lease to a visibility-timeout reclaim still records its ledger attempt but fires NO hook — the
 *   worker that owns the row does. So at most one hook fires per attempt, and a stale attempt fires
 *   none.
 * - At-least-once, not exactly-once: a retry fires `onRetry` again, and a redelivery after a crash
 *   can fire `onDelivered` more than once. Treat them as notifications keyed by id + attempt, not as
 *   the ledger (use the delivery-attempts ledger for that).
 * - Fail-open: an exception thrown by a hook is logged and swallowed so it can neither roll back the
 *   delivery state nor stall the dispatcher loop. Hooks run inline on the dispatch path, so keep them
 *   fast and offload slow work.
 */
export interface DeliveryHooks {
  /** A 2xx response moved the row to `delivered`. */
  onDelivered?: (event: DeliveryEvent) => void | Promise<void>;
  /** The attempt failed but more remain; the row is back to `pending` with a backoff. */
  onRetry?: (event: DeliveryEvent) => void | Promise<void>;
  /** The attempt failed and exhausted `maxAttempts` (or hit a permanent failure); the row moved to `dead`. */
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
  store: DispatchStore & EndpointStore;
  http: ReturnType<typeof createHttpClient>;
  config: RelayConfig;
  clock: Clock;
  /**
   * Surfaces security (SSRF block) and data-loss (DLQ) events even when no logger is configured.
   * Optional: when omitted it routes to `config.logger` as if a logger were configured (no console
   * fallback). `createRelay` always supplies the misconfiguration-aware instance.
   */
  critical?: CriticalLogger;
  hooks?: DeliveryHooks;
  /** Optional tracing/metrics seam; see {@link DeliveryInstrument}. */
  instrument?: DeliveryInstrument;
  /**
   * Delivery sink for `sink` transport. Required when
   * `config.delivery.transport === "sink"`; `createRelay` fails fast if it is missing. Unused for the
   * default `http` transport. Each handoff is bounded by `config.delivery.timeoutMs`.
   */
  sink?: Sink;
}

interface Ctx {
  row: OutboxRow;
  deps: DeliverDeps;
  /** Resolved critical-event logger (from `deps.critical`, else a configured-logger fallback). */
  critical: CriticalLogger;
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

type Resolved =
  { ok: true; url: string; secrets: string[]; halfOpen: boolean } | { ok: false; error: string };

/** Prefix the http client uses for an SSRF-blocked failure summary (e.g. `"SSRF_BLOCKED:metadata"`). */
const SSRF_BLOCKED_PREFIX = "SSRF_BLOCKED:";

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

/**
 * Pre-HTTP resolve errors that retrying can never fix, so the row goes straight to the DLQ instead of
 * burning the whole retry budget. `ENDPOINT_NOT_FOUND` / `ENDPOINT_DISABLED` are deliberately NOT here:
 * an admin can create or re-enable the endpoint, so those stay retryable.
 */
function isPermanentResolveError(error: string): boolean {
  return error === "MISSING_SECRET" || error === "ENQUEUE_NO_TARGET";
}

/**
 * Map a {@link SinkResult} onto success. A present `error` is always a
 * failure; otherwise a present `status` defers to the HTTP 2xx rule, and a bare result (no error, no
 * status) is a success.
 */
function isSinkSuccess(r: SinkResult): boolean {
  if (r.error != null) return false;
  return r.status != null ? isSuccess(r.status) : true;
}

/**
 * Map a failed {@link SinkResult} onto a permanent failure. A present
 * `status` defers to the HTTP permanent rule (410); otherwise an explicit `retryable === false` sends
 * the row straight to the DLQ. Everything else stays retryable.
 */
function isSinkPermanent(r: SinkResult): boolean {
  return r.status != null ? isPermanentFailure(r.status) : r.retryable === false;
}

/**
 * Coerce a sink's resolved value to a {@link SinkResult}. A contract-violating adapter that resolves to
 * a non-object (undefined/null/string/number) is mapped to a retryable failure, so a stray value is
 * never silently read as success (data loss) and `.status`/`.error` are never read off a non-object.
 */
function normalizeSinkResult(raw: unknown): SinkResult {
  return raw != null && typeof raw === "object"
    ? raw
    : { error: "SINK_BAD_RESULT", retryable: true };
}

/**
 * Race a promise against a timeout (used to bound a sink handoff). On timeout the returned promise
 * rejects with a `SINK_TIMEOUT` error; the underlying promise is left to settle in the background, but
 * `Promise.race` keeps a reaction attached to it so a late rejection is never unhandled.
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error("SINK_TIMEOUT"));
    }, ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * Resolve the destination URL and signing secret for a row (registered endpoint or inline).
 *
 * A disabled registered endpoint normally fails as `ENDPOINT_DISABLED`. With circuit-breaker
 * auto-recovery (`cooldownMs > 0`), once it has been disabled for at least `cooldownMs` (from
 * `disabled_at`) a delivery is let through as a half-open trial (`halfOpen: true`) so the caller can
 * re-activate it on success or re-arm the cooldown on failure. Note this is evaluated per row: under
 * the default `ordering: "none"` every currently-due `pending` row for the endpoint resolves
 * `halfOpen: true` in the same claim, so the trial is single only under `ordering: "per-endpoint"`.
 */
async function resolveTarget(
  row: OutboxRow,
  store: EndpointStore,
  recovery: { cooldownMs: number; now: Date },
): Promise<Resolved> {
  if (row.endpointId != null) {
    const ep = await store.findEndpoint(row.endpointId);
    if (!ep) return { ok: false, error: "ENDPOINT_NOT_FOUND" };
    // Dual-sign with the secondary key too during a rotation window (current key first).
    const secrets = ep.secretSecondary == null ? [ep.secret] : [ep.secret, ep.secretSecondary];
    if (ep.status === "disabled") {
      const { cooldownMs, now } = recovery;
      const dueForTrial =
        cooldownMs > 0 &&
        ep.disabledAt != null &&
        ep.disabledAt.getTime() + cooldownMs <= now.getTime();
      if (!dueForTrial) return { ok: false, error: "ENDPOINT_DISABLED" };
      return { ok: true, url: ep.url, secrets, halfOpen: true };
    }
    return { ok: true, url: ep.url, secrets, halfOpen: false };
  }
  if (row.targetUrl != null) {
    if (row.secretSnapshot == null) return { ok: false, error: "MISSING_SECRET" };
    return { ok: true, url: row.targetUrl, secrets: [row.secretSnapshot], halfOpen: false };
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
 * A guarded transition matched no row: this worker lost its lease to a visibility-timeout reclaim and
 * another worker now owns the row. The ledger attempt is still recorded, but we must NOT fire
 * success/retry/dead hooks, endpoint-health/breaker updates, or dead-letter alarms — the winning
 * worker will. We still settle the instrumentation with the real attempt outcome (the HTTP/sink call
 * did happen) and log the skip so the race is observable rather than silent.
 */
function noteStaleTransition(ctx: Ctx, event: DeliveryEvent): void {
  settle(ctx, event);
  ctx.deps.config.logger.info(
    "delivery transition skipped: row reclaimed by another worker (stale lease)",
    { id: ctx.row.id, endpointId: ctx.row.endpointId, attempt: ctx.row.attempts + 1 },
  );
}

/**
 * Success: write the ledger row and move to `delivered` in one round trip (store guards on
 * `status = 'in_flight'` and on `locked_by`), then — only when the transition actually applied —
 * notify onDelivered. Returns whether the transition applied so the caller can gate endpoint-health /
 * half-open recovery the same way. A stale worker (lease reclaimed) records its ledger row but fires
 * no success side effects.
 */
async function applySuccess(
  ctx: Ctx,
  attempt: NewDeliveryAttempt,
  event: DeliveryEvent,
): Promise<boolean> {
  const { transitionApplied } = await ctx.deps.store.completeAttempt(
    attempt,
    onSuccess(ctx.now),
    ctx.row.lockedBy,
  );
  if (!transitionApplied) {
    noteStaleTransition(ctx, event);
    return false;
  }
  await fireHook(ctx, ctx.deps.hooks?.onDelivered, event);
  return true;
}

/**
 * Surface a DLQ transition as a data-loss event: a message has reached the terminal `dead` state and
 * will never be delivered. Always routed through the critical logger so it is visible even when no
 * logger is configured (see {@link CriticalLogger}). The meta carries no secret.
 */
function noteDeadLetter(ctx: Ctx, summary: string): void {
  ctx.critical.dataLoss("message moved to the DLQ and is permanently lost", {
    id: ctx.row.id,
    endpointId: ctx.row.endpointId,
    eventType: ctx.row.eventType,
    attempts: ctx.row.attempts + 1,
    error: summary,
  });
}

/**
 * Failure: write the ledger row and schedule the next retry or move to `dead` in one round trip
 * (guarded on `status = 'in_flight'` and `locked_by`), then — only when the transition actually
 * applied — fire the dead-letter alarm and notify onRetry/onDead. Returns whether the transition
 * applied so the caller can gate endpoint-health. A stale worker (lease reclaimed) records its ledger
 * row but fires no retry/dead side effects.
 */
// eslint-disable-next-line max-params -- one optional Retry-After hint kept inline with the failure path
async function applyFailure(
  ctx: Ctx,
  attempt: NewDeliveryAttempt,
  summary: string,
  event: DeliveryEvent,
  retryAfterMs?: number | null,
): Promise<boolean> {
  const { row, deps, now } = ctx;
  const { retry } = deps.config;
  const dead = row.attempts + 1 >= retry.maxAttempts;
  // Honour a server-sent Retry-After when it exceeds our own backoff, clamped to retry.capMs so a
  // hostile/buggy header cannot park a row indefinitely.
  const base = backoffMs(row.attempts + 1, retry);
  const backoff = Math.min(Math.max(base, retryAfterMs ?? 0), retry.capMs);
  const { transitionApplied } = await deps.store.completeAttempt(
    attempt,
    onFailure(row, retry, now, summary, backoff),
    row.lockedBy,
  );
  if (!transitionApplied) {
    noteStaleTransition(ctx, event);
    return false;
  }
  if (dead) noteDeadLetter(ctx, summary);
  await fireHook(ctx, dead ? deps.hooks?.onDead : deps.hooks?.onRetry, event);
  return true;
}

/**
 * Permanent failure: write the ledger row and move straight to `dead` without consuming the retry
 * budget, then notify onDead. `opts.disableEndpoint` (default true, the HTTP 410 Gone path) also
 * disables the registered endpoint (fail-open — a disable error is logged, never propagated). It is
 * passed `false` for a deterministic pre-HTTP failure (missing/invalid signing secret), where the
 * endpoint itself is not the problem and should stay enabled.
 */
// eslint-disable-next-line max-params -- one optional endpoint-disable flag kept inline, mirroring applyFailure
async function applyPermanentFailure(
  ctx: Ctx,
  attempt: NewDeliveryAttempt,
  summary: string,
  event: DeliveryEvent,
  opts: { disableEndpoint?: boolean } = {},
): Promise<boolean> {
  const { row, deps, now } = ctx;
  const { transitionApplied } = await deps.store.completeAttempt(
    attempt,
    onPermanentFailure(row, summary),
    row.lockedBy,
  );
  if (!transitionApplied) {
    noteStaleTransition(ctx, event);
    return false;
  }
  noteDeadLetter(ctx, summary);
  if ((opts.disableEndpoint ?? true) && row.endpointId != null) {
    try {
      await deps.store.disableEndpoint(row.endpointId, now);
    } catch (err) {
      deps.config.logger.error("disableEndpoint on permanent failure failed", {
        id: row.id,
        endpointId: row.endpointId,
        error: secretFreeSummary(err),
      });
    }
  }
  await fireHook(ctx, deps.hooks?.onDead, event);
  return true;
}

/**
 * Circuit breaker (fail-open): on a real HTTP outcome to a registered endpoint, reset or increment
 * its consecutive-failure counter; the store auto-disables the endpoint when the count reaches the
 * configured threshold. No-op for inline destinations, or when the feature is off
 * (`failureThreshold === 0`). A counter-update error is logged and swallowed so it can never stall a
 * delivery — the row's own transition has already been applied.
 */
async function noteEndpointHealth(ctx: Ctx, success: boolean): Promise<void> {
  const { row, deps, now } = ctx;
  const threshold = deps.config.circuitBreaker.failureThreshold;
  if (row.endpointId == null || threshold <= 0) return;
  try {
    if (success) await deps.store.noteEndpointSuccess(row.endpointId);
    else await deps.store.noteEndpointFailure(row.endpointId, now, threshold);
  } catch (err) {
    deps.config.logger.error("circuit-breaker endpoint health update failed", {
      id: row.id,
      endpointId: row.endpointId,
      error: secretFreeSummary(err),
    });
  }
}

/**
 * Half-open recovery outcome (fail-open). A registered endpoint disabled past its cooldown was let
 * through as a trial delivery: on success re-activate it (`status = 'active'`, counter reset); on
 * failure re-arm the cooldown (refresh `disabled_at = now`) so it stays disabled and the next trial
 * waits another `cooldownMs` instead of retrying every attempt. Under `ordering: "none"` several of
 * the endpoint's due rows may run this concurrently (each call is idempotent: reactivate/disable
 * converge), so the redundant writes are harmless. Any store error is logged and swallowed — the
 * row's own transition has already been applied, so recovery never stalls a delivery.
 */
async function noteHalfOpenOutcome(ctx: Ctx, success: boolean): Promise<void> {
  const { row, deps, now } = ctx;
  if (row.endpointId == null) return;
  try {
    if (success) await deps.store.reactivateEndpoint(row.endpointId);
    else await deps.store.disableEndpoint(row.endpointId, now);
  } catch (err) {
    deps.config.logger.error("circuit-breaker half-open recovery update failed", {
      id: row.id,
      endpointId: row.endpointId,
      error: secretFreeSummary(err),
    });
  }
}

/** Run the POST, then write the ledger row and apply the success/failure transition in one round trip. */
async function deliverHttp(
  ctx: Ctx,
  url: string,
  secrets: string[],
  halfOpen: boolean,
): Promise<void> {
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
    const applied = await applySuccess(
      ctx,
      attempt,
      eventFor(ctx, res.status, null, res.durationMs),
    );
    // Only when this worker actually owned the transition: a successful half-open trial recovers the
    // endpoint, otherwise this is the normal health reset. A stale worker touches neither.
    if (applied) {
      if (halfOpen) await noteHalfOpenOutcome(ctx, true);
      else await noteEndpointHealth(ctx, true);
    }
    return;
  }
  const event = eventFor(ctx, res.status, failure, res.durationMs);
  // An SSRF block is a security event: the destination resolved to a blocked address and the POST was
  // refused. Surface it every attempt (it stays retryable) so it is never silent on a misconfig.
  if (res.error?.startsWith(SSRF_BLOCKED_PREFIX)) {
    ctx.critical.securityBlocked(
      "delivery refused: destination resolved to a blocked address (SSRF)",
      {
        id: row.id,
        endpointId: row.endpointId,
        host: ctx.host,
        reason: res.error.slice(SSRF_BLOCKED_PREFIX.length),
      },
    );
  }
  if (isPermanentFailure(res.status)) {
    // 410 Gone already disables the endpoint via applyPermanentFailure (which also re-arms the
    // cooldown by refreshing disabled_at); the breaker / half-open re-arm would be redundant.
    await applyPermanentFailure(ctx, attempt, failure, event);
    return;
  }
  const retryAfterMs = parseRetryAfter(res.retryAfter, now.getTime());
  const applied = await applyFailure(ctx, attempt, failure, event, retryAfterMs);
  // Only when this worker actually owned the transition: a failed half-open trial re-arms the cooldown
  // (keep it disabled), otherwise note the failure so the breaker can trip. They are mutually
  // exclusive: a half-open row's endpoint is already disabled. A stale worker touches neither.
  if (applied) {
    if (halfOpen) await noteHalfOpenOutcome(ctx, false);
    else await noteEndpointHealth(ctx, false);
  }
}

/**
 * `sink` transport: hand the row to the configured sink, then write the
 * ledger and apply the transition atomically. No signing, SSRF or circuit breaker — those are delegated
 * to the sink/SaaS. A throwing adapter is normalised to a retryable failure (fail-open). Signing/SSRF
 * are skipped entirely so a sink delivery never resolves a target URL or secret. The handoff is bounded
 * by `delivery.timeoutMs` so a hung adapter cannot pin a dispatcher slot, but the adapter is still
 * responsible for its own latency/timeout.
 */
async function deliverSink(ctx: Ctx, sink: Sink | undefined): Promise<void> {
  const { row } = ctx;
  if (sink == null) {
    // createRelay fails fast on a missing sink, so this is unreachable in practice. Stay never-throw:
    // record a deterministic permanent failure rather than retrying a config error to exhaustion.
    const attempt = noHttpAttempt(row, "SINK_NOT_CONFIGURED");
    const event = eventFor(ctx, null, "SINK_NOT_CONFIGURED", 0);
    await applyPermanentFailure(ctx, attempt, "SINK_NOT_CONFIGURED", event, {
      disableEndpoint: false,
    });
    return;
  }
  const started = ctx.now.getTime();
  let result: SinkResult;
  try {
    // Bound the handoff by delivery.timeoutMs so a hung adapter cannot pin a dispatcher slot; on
    // timeout this rejects with SINK_TIMEOUT and is normalised to a retryable failure. The adapter is
    // still responsible for its own latency/timeout (the SaaS call may keep running). A non-SinkResult
    // return is coerced to a retryable failure (never silently read as success).
    result = normalizeSinkResult(
      await withTimeout(
        sink.deliver({
          id: row.id,
          eventType: row.eventType,
          payload: row.payload,
          idempotencyKey: row.idempotencyKey ?? undefined,
          endpointId: row.endpointId,
        }),
        ctx.deps.config.delivery.timeoutMs,
      ),
    );
  } catch (err) {
    // A throwing/timed-out adapter is normalised to a retryable failure (fail-open, never crash the loop).
    result = { error: secretFreeSummary(err), retryable: true };
  }
  const durationMs = ctx.deps.clock().getTime() - started;
  const status = result.status ?? null;
  const success = isSinkSuccess(result);
  const attempt: NewDeliveryAttempt = {
    outboxId: row.id,
    attemptNo: row.attempts + 1,
    // No request headers / destination URL in sink mode; record the provider id for correlation only.
    requestHeaders:
      result.providerMessageId != null ? { "provider-message-id": result.providerMessageId } : {},
    responseStatus: status,
    responseBodySnippet: null,
    durationMs,
    error: success ? null : (result.error ?? "SINK_FAILED"),
  };
  if (success) {
    await applySuccess(ctx, attempt, eventFor(ctx, status, null, durationMs));
    return;
  }
  const summary = result.error ?? "SINK_FAILED";
  const event = eventFor(ctx, status, summary, durationMs);
  // No circuit breaker / endpoint health in sink mode: the destination is a single SaaS, not a
  // per-endpoint URL, so disableEndpoint is always false.
  if (isSinkPermanent(result)) {
    await applyPermanentFailure(ctx, attempt, summary, event, { disableEndpoint: false });
    return;
  }
  await applyFailure(ctx, attempt, summary, event);
}

/**
 * Deliver one claimed row, writing the ledger and applying the transition. Never throws: a
 * delivery-side failure is logged and persisted as a retryable failure (fail-open).
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
  // Without an explicit critical logger, route to the configured logger (no console fallback);
  // createRelay always injects the misconfiguration-aware instance.
  const critical = deps.critical ?? createCriticalLogger(deps.config.logger, true);
  const ctx: Ctx = {
    row,
    deps,
    critical,
    now: deps.clock(),
    host,
    finish,
    settled: { done: false },
  };
  try {
    // `sink` transport bypasses target/secret resolution, signing and SSRF entirely.
    if (deps.config.delivery.transport === "sink") {
      await deliverSink(ctx, deps.sink);
      return;
    }
    const resolved = await resolveTarget(row, deps.store, {
      cooldownMs: deps.config.circuitBreaker.cooldownMs,
      now: ctx.now,
    });
    if (!resolved.ok) {
      const attempt = noHttpAttempt(row, resolved.error);
      const event = eventFor(ctx, null, resolved.error, 0);
      // A row that can never resolve a target/secret will never succeed: send it straight to the DLQ
      // instead of retrying maxAttempts times. The endpoint is not at fault, so do not disable it.
      if (isPermanentResolveError(resolved.error)) {
        await applyPermanentFailure(ctx, attempt, resolved.error, event, {
          disableEndpoint: false,
        });
      } else {
        await applyFailure(ctx, attempt, resolved.error, event);
      }
      return;
    }
    await deliverHttp(ctx, resolved.url, resolved.secrets, resolved.halfOpen);
  } catch (err) {
    const summary = secretFreeSummary(err);
    deps.config.logger.error("deliverOne failed", { id: row.id, error: summary });
    // A CONFIG_INVALID here is a deterministic signing/secret problem (empty or malformed secret, an
    // undecryptable registered-endpoint secret): retrying cannot fix it, so go straight to dead. Any
    // other error (a transient DB failure, etc.) stays retryable.
    const permanent = err instanceof RelayError && err.code === "CONFIG_INVALID";
    try {
      const attempt = noHttpAttempt(row, summary);
      const event = eventFor(ctx, null, summary, 0);
      if (permanent) {
        await applyPermanentFailure(ctx, attempt, summary, event, { disableEndpoint: false });
      } else {
        await applyFailure(ctx, attempt, summary, event);
      }
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
