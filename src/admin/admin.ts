/**
 * Admin operations (per 05-admin-api sections 5-7): ledger queries, replay, and endpoint
 * disabling. These are thin, side-effect-light wrappers over the {@link Store}; the root
 * {@link "../relay".createRelay} composes them into the public `Relay`.
 */
import { newId } from "../id";
import { RelayError } from "../core/index";
import type { DeliveryAttempt, EndpointRow } from "../core/index";
import { ALL_STATUSES } from "../store/_shared";
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
 * Replay matching rows by inserting fresh `pending` copies (05 section 6). The original (e.g.
 * dead) rows are kept as history; each copy inherits the destination, payload, eventType and
 * `idempotencyKey` so the receiver can dedupe a re-send. Returns the new ids.
 */
export async function replay(
  store: Store,
  now: Date,
  opts: { outboxId: string } | { filter: ReplayFilter },
): Promise<{ ids: string[] }> {
  const filter: ReplayFilter = "filter" in opts ? opts.filter : { outboxId: opts.outboxId };
  const rows = await store.selectForReplay(filter);
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
  return { ids };
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
