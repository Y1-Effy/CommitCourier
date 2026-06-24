/**
 * Admin operations (per 05-admin-api sections 5-7): ledger queries, replay, and endpoint
 * disabling. These are thin, side-effect-light wrappers over the {@link Store}; the root
 * {@link "../relay".createRelay} composes them into the public `Relay`.
 */
import { randomUUID } from "node:crypto";
import type { DeliveryAttempt } from "../core/index";
import type { Store, ReplayFilter, NewOutboxRow } from "../store/store";

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
    id: randomUUID(),
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

/** Disable a registered endpoint so no further deliveries target it (05 section 7). */
export function disableEndpoint(store: Store, endpointId: string, now: Date): Promise<void> {
  return store.disableEndpoint(endpointId, now);
}
