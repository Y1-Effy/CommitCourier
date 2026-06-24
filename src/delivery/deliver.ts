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

export interface DeliverDeps {
  store: Store;
  http: ReturnType<typeof createHttpClient>;
  config: RelayConfig;
  clock: Clock;
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

/** Record the ledger row, then move the outbox row to delivered or schedule the next retry. */
async function applyOutcome(
  ctx: Ctx,
  attempt: NewDeliveryAttempt,
  success: boolean,
): Promise<void> {
  const { row, deps, now } = ctx;
  await deps.store.recordAttempt(attempt);
  if (success) {
    await deps.store.applyTransition(row.id, onSuccess(now));
    return;
  }
  const backoff = backoffMs(row.attempts + 1, deps.config.retry);
  const summary = attempt.error ?? "delivery failed";
  await deps.store.applyTransition(
    row.id,
    onFailure(row, deps.config.retry, now, summary, backoff),
  );
}

/** Run the POST and turn its {@link HttpResult} into a ledger row plus a transition. */
async function deliverHttp(ctx: Ctx, url: string, secret: string): Promise<void> {
  const { row, deps, now } = ctx;
  const body = JSON.stringify(row.payload);
  const sig = await sign({
    id: row.id,
    timestampSec: Math.floor(now.getTime() / 1000),
    body,
    secret,
  });
  const headers = buildHeaders(sig, row);
  const res = await deps.http.post({ url, headers, body });
  const success = isSuccess(res.status);
  await applyOutcome(
    ctx,
    {
      outboxId: row.id,
      attemptNo: row.attempts + 1,
      requestHeaders: headers,
      responseStatus: res.status,
      responseBodySnippet: res.bodySnippet,
      durationMs: res.durationMs,
      error: res.error ?? (success ? null : `HTTP ${String(res.status)}`),
    },
    success,
  );
}

/**
 * Deliver one claimed row, recording the ledger and applying the transition. Never throws:
 * unexpected errors are logged and recorded as a retryable failure (fail-open, section 4).
 */
export async function deliverOne(row: OutboxRow, deps: DeliverDeps): Promise<void> {
  const ctx: Ctx = { row, deps, now: deps.clock() };
  try {
    const resolved = await resolveTarget(row, deps.store);
    if (!resolved.ok) {
      await applyOutcome(ctx, noHttpAttempt(row, resolved.error), false);
      return;
    }
    await deliverHttp(ctx, resolved.url, resolved.secret);
  } catch (err) {
    deps.config.logger.error("deliverOne failed", { id: row.id, error: secretFreeSummary(err) });
    try {
      await applyOutcome(ctx, noHttpAttempt(row, secretFreeSummary(err)), false);
    } catch (inner) {
      // Even the failover record failed; swallow so the dispatcher loop keeps running.
      deps.config.logger.error("deliverOne failover record failed", {
        id: row.id,
        error: secretFreeSummary(inner),
      });
    }
  }
}
