/**
 * Admin operations: ledger queries, replay, and endpoint
 * disabling. These are thin, side-effect-light wrappers over the {@link Store}; the root
 * {@link "../relay".createRelay} composes them into the public `Relay`.
 */
import { newId } from "../id";
import { RelayError } from "../core/index";
import type { DeliveryAttempt, DeliveryConfig, EndpointRow, Status } from "../core/index";
// Direct import: internal to the package and deliberately absent from the core barrel.
import { validateCustomHeaders } from "../core/headers";
import {
  ALL_STATUSES,
  clampReplayLimit,
  clampPruneLimit,
  PRUNABLE_STATUSES,
  DEFAULT_PRUNE_STATUSES,
} from "../store/_shared";
import type {
  OutboxQueryStore,
  EndpointStore,
  ReplayStore,
  MaintenanceStore,
  ReplayFilter,
  NewOutboxRow,
  NewEndpointRow,
  EndpointPatch,
  OutboxListFilter,
  OutboxListItem,
  EndpointListFilter,
  EndpointSummary,
  Page,
} from "../store/store";

/** Read the delivery ledger for one outbox row. */
export function attempts(store: OutboxQueryStore, outboxId: string): Promise<DeliveryAttempt[]> {
  return store.queryAttempts({ outboxId });
}

/** A bigint `seq` cursor: one or more decimal digits. */
const SEQ_CURSOR_RE = /^\d+$/;
/** Postgres `bigint` upper bound; a `seq` cursor above this overflows the `::bigint` cast. */
const INT64_MAX = 9223372036854775807n;
/** A uuid (`id`/`endpointId`) value. */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * List outbox rows (read-only, secret-free) for DLQ inspection/monitoring. Newest-first by the
 * monotonic `seq`; pass the returned `nextCursor` to page. A common DLQ query is `{ status: "dead" }`.
 *
 * Validates the filter up front so a malformed `status`/`endpointId`/`cursor` fails as a clean,
 * awaitable `INVALID_ARGUMENT` rejection rather than a raw Postgres cast error from
 * `endpoint_id = $n` (uuid) or `seq < ($n)::bigint`. (`limit` is clamped in the store.) `async` so
 * the rejection is delivered through the returned Promise, never thrown synchronously.
 */
export async function listOutbox(
  store: OutboxQueryStore,
  filter: OutboxListFilter = {},
): Promise<Page<OutboxListItem>> {
  if (filter.status !== undefined && !(ALL_STATUSES as readonly string[]).includes(filter.status)) {
    throw new RelayError("INVALID_ARGUMENT", `list: unknown status "${filter.status}"`);
  }
  if (filter.endpointId !== undefined && !UUID_RE.test(filter.endpointId)) {
    throw new RelayError(
      "INVALID_ARGUMENT",
      `list: endpointId must be a uuid, got "${filter.endpointId}"`,
    );
  }
  if (
    filter.cursor !== undefined &&
    (!SEQ_CURSOR_RE.test(filter.cursor) || BigInt(filter.cursor) > INT64_MAX)
  ) {
    throw new RelayError(
      "INVALID_ARGUMENT",
      `list: cursor must be a numeric seq within int64, got "${filter.cursor}"`,
    );
  }
  return store.listOutbox(filter);
}

/**
 * List registered endpoints (read-only, secret-free); pass the returned `nextCursor` to page.
 * Validates `status`/`cursor` so a malformed value fails as a clean, awaitable `INVALID_ARGUMENT`
 * rejection rather than a raw Postgres uuid-cast error from `id > $n`. `async` so the rejection is
 * delivered through the returned Promise, never thrown synchronously.
 */
export async function listEndpoints(
  store: EndpointStore,
  filter: EndpointListFilter = {},
): Promise<Page<EndpointSummary>> {
  if (
    filter.status !== undefined &&
    !(["active", "disabled"] as readonly string[]).includes(filter.status)
  ) {
    throw new RelayError("INVALID_ARGUMENT", `endpoints.list: unknown status "${filter.status}"`);
  }
  if (filter.cursor !== undefined && !UUID_RE.test(filter.cursor)) {
    throw new RelayError(
      "INVALID_ARGUMENT",
      `endpoints.list: cursor must be a uuid, got "${filter.cursor}"`,
    );
  }
  return store.listEndpoints(filter);
}

/**
 * Cancel a not-yet-sent outbox row: moves it `pending` -&gt; `cancelled` only while it is
 * still pending. Returns `{ cancelled }` — false when the row was already claimed/sent or the id is
 * unknown, so a caller can tell "stopped in time" from "too late". Validates the id up front so a
 * malformed value fails as a clean `INVALID_ARGUMENT` rather than a raw uuid-cast error.
 */
export async function cancel(
  store: OutboxQueryStore,
  outboxId: string,
): Promise<{ cancelled: boolean }> {
  if (!UUID_RE.test(outboxId)) {
    throw new RelayError("INVALID_ARGUMENT", `cancel: outboxId must be a uuid, got "${outboxId}"`);
  }
  return { cancelled: await store.cancel(outboxId) };
}

/**
 * Fetch one outbox row by id (read-only, secret-free), or null when unknown. Validates the id so a
 * malformed value fails as a clean `INVALID_ARGUMENT` rather than a raw uuid-cast error.
 */
export async function getOutbox(
  store: OutboxQueryStore,
  outboxId: string,
): Promise<OutboxListItem | null> {
  if (!UUID_RE.test(outboxId)) {
    throw new RelayError("INVALID_ARGUMENT", `get: outboxId must be a uuid, got "${outboxId}"`);
  }
  return store.getOutbox(outboxId);
}

/**
 * Replay matching rows by inserting fresh `pending` copies. The original (e.g.
 * dead) rows are kept as history; each copy inherits the destination, payload, eventType and
 * `idempotencyKey` so the receiver can dedupe a re-send. The selection is always clamped to a safe
 * ceiling so a broad filter can never fan out into an unbounded mass re-send.
 *
 * Returns the new ids plus `capped`: true when the selection hit the (clamped) limit, so not every
 * matching row was replayed. To replay more, NARROW the filter (e.g. by `endpointId` / a tighter
 * `since`) or raise `filter.limit` — do NOT re-call with the same filter: replay leaves the source
 * rows untouched, so an identical call re-selects the same head rows and re-sends them (duplicates).
 */
export async function replay(
  store: ReplayStore,
  now: Date,
  opts: { outboxId: string } | { filter: ReplayFilter },
): Promise<{ ids: string[]; capped: boolean }> {
  const base: ReplayFilter = "filter" in opts ? opts.filter : { outboxId: opts.outboxId };
  // Replay re-activates rows as fresh pending copies, so a still-active row would be duplicated by
  // the dispatcher's own delivery. Reject an explicit active-status filter up front (mirrors prune's
  // refusal to touch live rows); the store also guards so a broad/no-status filter excludes them.
  if (base.status === "pending" || base.status === "in_flight") {
    throw new RelayError(
      "INVALID_ARGUMENT",
      `replay: status "${base.status}" is not replayable (only non-active rows can be replayed)`,
    );
  }
  const limit = clampReplayLimit(base.limit);
  const rows = await store.selectForReplay({ ...base, limit });
  const copies: NewOutboxRow[] = rows.map((src) => ({
    id: newId(),
    eventType: src.eventType,
    payload: src.payload,
    endpointId: src.endpointId,
    targetUrl: src.targetUrl,
    secretSnapshot: src.secretSnapshot,
    status: "pending",
    attempts: 0,
    availableAt: now,
    idempotencyKey: src.idempotencyKey,
  }));
  const ids = await store.insertReplayCopies(copies);
  // A full page means the limit may have truncated the match set; signal the caller to page on.
  return { ids, capped: rows.length >= limit };
}

/** Options for `relay.prune`. `olderThan` is required; `statuses`/`limit` default and are clamped. */
export interface PruneOptions {
  /** Delete only rows whose `created_at` is strictly before this. Required (no implicit "all time"). */
  olderThan: Date;
  /**
   * Which statuses to delete. Defaults to `['delivered','dead','cancelled']`. Every value must be a
   * non-active status (`delivered`/`dead`/`cancelled`/`observed`); passing `pending`/`in_flight`
   * fails as `INVALID_ARGUMENT` so a live row can never be pruned out from under a delivery.
   */
  statuses?: Status[];
  /** Max rows to delete in this call; clamped to a safe ceiling. Defaults to a batch size. */
  limit?: number;
}

/**
 * Retention: delete terminal rows older than `opts.olderThan`, oldest first, in a bounded batch
 * (ledger attempts cascade). Returns `{ deleted }`; `deleted === limit` (the clamped limit) means more
 * may remain, so call again to keep pruning. Validates that every requested status is prunable
 * (non-active) up front, so a `pending`/`in_flight` row is never deleted.
 */
export async function prune(
  store: MaintenanceStore,
  opts: PruneOptions,
): Promise<{ deleted: number }> {
  if (!(opts.olderThan instanceof Date) || Number.isNaN(opts.olderThan.getTime())) {
    throw new RelayError("INVALID_ARGUMENT", "prune: olderThan must be a valid Date");
  }
  const statuses = opts.statuses ?? DEFAULT_PRUNE_STATUSES;
  const allowed = PRUNABLE_STATUSES as readonly string[];
  for (const s of statuses) {
    if (!allowed.includes(s)) {
      throw new RelayError(
        "INVALID_ARGUMENT",
        `prune: status "${s}" is not prunable (allowed: ${PRUNABLE_STATUSES.join(", ")})`,
      );
    }
  }
  return store.prune({ olderThan: opts.olderThan, statuses, limit: clampPruneLimit(opts.limit) });
}

/**
 * What the endpoint admin calls need to know about the relay's own config to validate their input.
 * Only the transport so far, for the `sink` check in {@link assertCustomHeadersAllowed}.
 */
export interface EndpointAdminContext {
  transport: DeliveryConfig["transport"];
}

/**
 * Reject custom headers under the `sink` transport, where CommitCourier hands the event to the
 * sink/SaaS and never builds the request itself — the headers would be silently dropped.
 *
 * This is the `createRelay` fail-fast for a missing sink (`relay.ts`) moved to the earliest point it
 * can actually run: the transport is relay config, known at startup, but custom headers live on
 * endpoint rows written at runtime, possibly by another process, so startup cannot see them. Checking
 * on the way in catches the mistake when the caller is there to be told about it. It deliberately does
 * not reject *existing* rows that carry headers, so a staged migration from the http transport to the
 * sink transport is not blocked by leftovers — matching the non-fatal warning `createRelay` already
 * emits for the other delegated settings.
 */
function assertCustomHeadersAllowed(
  ctx: EndpointAdminContext,
  customHeaders: Record<string, string> | null | undefined,
): void {
  if (ctx.transport === "sink" && customHeaders != null) {
    throw new RelayError(
      "CONFIG_INVALID",
      'delivery.transport "sink" delegates delivery to the sink/SaaS, so per-endpoint custom headers ' +
        "are never sent; configure them on the sink instead",
    );
  }
}

/** Register a new endpoint (status defaults to `active`). Returns the generated id. */
export async function registerEndpoint(
  store: EndpointStore,
  input: {
    url: string;
    secret: string;
    description?: string | null;
    customHeaders?: Record<string, string> | null;
    metadata?: Record<string, unknown> | null;
  },
  ctx: EndpointAdminContext,
): Promise<{ id: string }> {
  assertCustomHeadersAllowed(ctx, input.customHeaders);
  const ep: NewEndpointRow = {
    id: newId(),
    url: input.url,
    secret: input.secret,
    description: input.description ?? null,
    customHeaders: input.customHeaders == null ? null : validateCustomHeaders(input.customHeaders),
    metadata: input.metadata ?? null,
  };
  await store.insertEndpoint(ep);
  return { id: ep.id };
}

/**
 * Patch a registered endpoint; only the provided fields change. `customHeaders` replaces the whole
 * map (null clears it) and is validated the same way as at registration.
 *
 * Async so a validation rejection is delivered through the returned Promise rather than thrown
 * synchronously, matching the other admin calls.
 */
export async function updateEndpoint(
  store: EndpointStore,
  id: string,
  patch: EndpointPatch,
  ctx: EndpointAdminContext,
): Promise<void> {
  assertCustomHeadersAllowed(ctx, patch.customHeaders);
  const next: EndpointPatch =
    patch.customHeaders == null
      ? patch
      : { ...patch, customHeaders: validateCustomHeaders(patch.customHeaders) };
  await store.updateEndpoint(id, next);
}

/**
 * Begin a key rotation: promote the current secret to the secondary slot and set `newSecret` as the
 * primary, so deliveries are dual-signed with both keys until {@link finalizeRotation} drops the old
 * one. Throws `ENDPOINT_NOT_FOUND` when the id is unknown.
 */
export async function rotateEndpointSecret(
  store: EndpointStore,
  id: string,
  newSecret: string,
): Promise<void> {
  const ep = await store.findEndpoint(id);
  if (!ep) throw new RelayError("ENDPOINT_NOT_FOUND", `endpoint not found: ${id}`);
  await store.updateEndpoint(id, { secret: newSecret, secretSecondary: ep.secret });
}

/** Finish a key rotation: drop the secondary secret so deliveries sign with the new key only. */
export function finalizeRotation(store: EndpointStore, id: string): Promise<void> {
  return store.updateEndpoint(id, { secretSecondary: null });
}

/**
 * Re-enable a disabled endpoint: clears the disabled marker AND resets the circuit-breaker
 * `consecutive_failures` counter, so a manually re-enabled endpoint gets a full `failureThreshold`
 * budget again (otherwise a breaker-disabled endpoint, whose counter is already at the threshold,
 * would be auto-disabled by the very next failed delivery). Reuses `reactivateEndpoint`, the same
 * single-UPDATE the circuit breaker's half-open recovery uses (`status='active'`,
 * `consecutive_failures=0`, `disabled_at=NULL`), so manual and automatic recovery behave identically.
 */
export function enableEndpoint(store: EndpointStore, id: string): Promise<void> {
  return store.reactivateEndpoint(id);
}

/** Look up a registered endpoint. */
export function getEndpoint(store: EndpointStore, id: string): Promise<EndpointRow | null> {
  return store.findEndpoint(id);
}

/**
 * Disable a registered endpoint so no further deliveries target it. A deliberate admin disable is
 * sticky: it marks the endpoint `disabled` and clears `disabled_at` (the circuit-breaker auto-recovery
 * cooldown anchor), so — unlike a breaker / `410 Gone` auto-disable, which stamps `disabled_at = now` —
 * it is never re-tried by half-open recovery. It stays disabled until {@link enableEndpoint}.
 */
export function disableEndpoint(store: EndpointStore, endpointId: string): Promise<void> {
  return store.updateEndpoint(endpointId, { status: "disabled", disabledAt: null });
}
