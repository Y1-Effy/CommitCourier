/**
 * Admin operations (per 05-admin-api sections 5-7): ledger queries, replay, and endpoint
 * disabling. These are thin, side-effect-light wrappers over the {@link Store}; the root
 * {@link "../relay".createRelay} composes them into the public `Relay`.
 */
import { newId } from "../id";
import { RelayError } from "../core/index";
import type { DeliveryAttempt, EndpointRow, Status } from "../core/index";
import {
  ALL_STATUSES,
  clampReplayLimit,
  clampPruneLimit,
  PRUNABLE_STATUSES,
  DEFAULT_PRUNE_STATUSES,
} from "../store/_shared";
import type {
  Store,
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

/** Read the delivery ledger for one outbox row (05 section 5). */
export function attempts(store: Store, outboxId: string): Promise<DeliveryAttempt[]> {
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
  store: Store,
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
  store: Store,
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
 * Cancel a not-yet-sent outbox row (05 section 6): moves it `pending` -&gt; `cancelled` only while it is
 * still pending. Returns `{ cancelled }` — false when the row was already claimed/sent or the id is
 * unknown, so a caller can tell "stopped in time" from "too late". Validates the id up front so a
 * malformed value fails as a clean `INVALID_ARGUMENT` rather than a raw uuid-cast error.
 */
export async function cancel(store: Store, outboxId: string): Promise<{ cancelled: boolean }> {
  if (!UUID_RE.test(outboxId)) {
    throw new RelayError("INVALID_ARGUMENT", `cancel: outboxId must be a uuid, got "${outboxId}"`);
  }
  return { cancelled: await store.cancel(outboxId) };
}

/**
 * Fetch one outbox row by id (read-only, secret-free), or null when unknown. Validates the id so a
 * malformed value fails as a clean `INVALID_ARGUMENT` rather than a raw uuid-cast error.
 */
export async function getOutbox(store: Store, outboxId: string): Promise<OutboxListItem | null> {
  if (!UUID_RE.test(outboxId)) {
    throw new RelayError("INVALID_ARGUMENT", `get: outboxId must be a uuid, got "${outboxId}"`);
  }
  return store.getOutbox(outboxId);
}

/**
 * Replay matching rows by inserting fresh `pending` copies (05 section 6). The original (e.g.
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
  store: Store,
  now: Date,
  opts: { outboxId: string } | { filter: ReplayFilter },
): Promise<{ ids: string[]; capped: boolean }> {
  const base: ReplayFilter = "filter" in opts ? opts.filter : { outboxId: opts.outboxId };
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
export async function prune(store: Store, opts: PruneOptions): Promise<{ deleted: number }> {
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

/** Register a new endpoint (status defaults to `active`). Returns the generated id (05 section 7). */
export async function registerEndpoint(
  store: Store,
  input: {
    url: string;
    secret: string;
    description?: string | null;
    metadata?: Record<string, unknown> | null;
  },
): Promise<{ id: string }> {
  const ep: NewEndpointRow = {
    id: newId(),
    url: input.url,
    secret: input.secret,
    description: input.description ?? null,
    metadata: input.metadata ?? null,
  };
  await store.insertEndpoint(ep);
  return { id: ep.id };
}

/** Patch a registered endpoint; only the provided fields change (05 section 7). */
export function updateEndpoint(store: Store, id: string, patch: EndpointPatch): Promise<void> {
  return store.updateEndpoint(id, patch);
}

/**
 * Begin a key rotation: promote the current secret to the secondary slot and set `newSecret` as the
 * primary, so deliveries are dual-signed with both keys until {@link finalizeRotation} drops the old
 * one. Throws `ENDPOINT_NOT_FOUND` when the id is unknown.
 */
export async function rotateEndpointSecret(
  store: Store,
  id: string,
  newSecret: string,
): Promise<void> {
  const ep = await store.findEndpoint(id);
  if (!ep) throw new RelayError("ENDPOINT_NOT_FOUND", `endpoint not found: ${id}`);
  await store.updateEndpoint(id, { secret: newSecret, secretSecondary: ep.secret });
}

/** Finish a key rotation: drop the secondary secret so deliveries sign with the new key only. */
export function finalizeRotation(store: Store, id: string): Promise<void> {
  return store.updateEndpoint(id, { secretSecondary: null });
}

/** Re-enable a disabled endpoint (clears the disabled marker) (05 section 7). */
export function enableEndpoint(store: Store, id: string): Promise<void> {
  return store.updateEndpoint(id, { status: "active", disabledAt: null });
}

/** Look up a registered endpoint (05 section 7). */
export function getEndpoint(store: Store, id: string): Promise<EndpointRow | null> {
  return store.findEndpoint(id);
}

/** Disable a registered endpoint so no further deliveries target it (05 section 7). */
export function disableEndpoint(store: Store, endpointId: string, now: Date): Promise<void> {
  return store.disableEndpoint(endpointId, now);
}
