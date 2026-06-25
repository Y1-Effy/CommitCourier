/**
 * Admin operations (per 05-admin-api sections 5-7): ledger queries, replay, and endpoint
 * disabling. These are thin, side-effect-light wrappers over the {@link Store}; the root
 * {@link "../relay".createRelay} composes them into the public `Relay`.
 */
import { newId } from "../id";
import type { DeliveryAttempt, EndpointRow } from "../core/index";
import type {
  Store,
  ReplayFilter,
  NewOutboxRow,
  NewEndpointRow,
  EndpointPatch,
} from "../store/store";

/** Read the delivery ledger for one outbox row (05 section 5). */
export function attempts(store: Store, outboxId: string): Promise<DeliveryAttempt[]> {
  return store.queryAttempts({ outboxId });
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
