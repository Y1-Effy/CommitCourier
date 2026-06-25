/**
 * The universal persistence port (per 02-store section 2).
 *
 * This is the single, storage-paradigm-neutral contract every backend implements. It is NOT tied
 * to SQL: the relational adapters (`pg`, `knex`) implement it on top of the shared SQL plumbing
 * (`./_shared`) and a dialect (`./sql/*`), but a document/NoSQL backend (e.g. MongoDB) implements
 * exactly the same interface directly, with no SQL. The behavioural contract below — not any
 * particular query — is what an adapter must satisfy.
 *
 * This module imports core types only; it must never import a driver, a dialect, or SQL.
 *
 * Only the `enqueue` path uses a user-supplied transaction handle, expressed by the generic `TTx`;
 * adapters bind it to a concrete handle (pg `PoolClient`, knex `Knex.Transaction`, a MongoDB
 * `ClientSession`, …). Dispatch-path operations acquire their own connection/session.
 */
import type { Status, OutboxRow, DeliveryAttempt, EndpointRow, Transition } from "../core/index";

/** Row to INSERT into the outbox. `id`/`status`/`availableAt` are decided by core, not the DB. */
export interface NewOutboxRow {
  id: string;
  eventType: string;
  payload: unknown;
  endpointId: string | null;
  targetUrl: string | null;
  secretSnapshot: string | null;
  status: Status;
  attempts: number;
  availableAt: Date;
  idempotencyKey: string | null;
}

/** Row to append to the delivery ledger. `attemptedAt` defaults to now() when omitted. */
export interface NewDeliveryAttempt {
  outboxId: string;
  attemptNo: number;
  /** Request headers sent; never includes the secret itself. */
  requestHeaders: Record<string, string>;
  responseStatus: number | null;
  responseBodySnippet: string | null;
  durationMs: number;
  error: string | null;
}

/** Filter for selecting rows to replay (admin). */
export interface ReplayFilter {
  outboxId?: string;
  status?: Status; // e.g. "dead"
  since?: Date;
}

/** Row to INSERT into the registered-endpoint table. `status` defaults to `active` in the store. */
export interface NewEndpointRow {
  id: string;
  url: string;
  secret: string;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** Partial update for a registered endpoint; only the provided fields are changed. */
export interface EndpointPatch {
  url?: string;
  secret?: string;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
  status?: EndpointRow["status"];
  disabledAt?: Date | null;
}

/** Aggregate counts of outbox rows by status, plus the age of the oldest pending row. */
export interface OutboxStats {
  counts: Record<Status, number>;
  /** `availableAt` of the oldest `pending` row, or null when the queue is empty. */
  oldestPendingAt: Date | null;
}

/**
 * The persistence port. An adapter is correct when it upholds the per-method semantics below,
 * regardless of the underlying engine (SQL or NoSQL).
 *
 * @typeParam TTx - the transaction-handle type the user passes to {@link Store.insertOutbox}
 * (adapter-specific, e.g. pg `PoolClient`, knex `Knex.Transaction`, MongoDB `ClientSession`).
 */
export interface Store<TTx = unknown> {
  /**
   * enqueue path: enlist in the caller's transaction `trx` and persist one outbox row, so the
   * enqueue commits or rolls back atomically with the caller's business write (fail-closed). Any
   * error must propagate (it is the caller's TX that rolls back).
   *
   * A backend with no multi-statement transactions cannot honour this atomicity and may instead
   * support only {@link Store.insertOutboxAutonomous} (the degraded `enqueueUnsafe` path). MongoDB
   * can honour it via a `ClientSession`, but only on a replica set / sharded cluster.
   */
  insertOutbox(trx: TTx, row: NewOutboxRow): Promise<void>;

  /** Bulk enqueue path: persist many outbox rows in one round trip, enlisting in `trx` (fail-closed). */
  insertOutboxMany(trx: TTx, rows: NewOutboxRow[]): Promise<void>;

  /** Non-TX enqueue (for enqueueUnsafe): persist via the store's own connection. No atomicity guarantee. */
  insertOutboxAutonomous(row: NewOutboxRow): Promise<void>;

  /**
   * dispatch path: atomically claim up to `limit` due rows (`status = 'pending'` and
   * `availableAt <= now`, oldest first), moving each to `in_flight` with `lockedBy`/`lockedAt`,
   * and return the claimed rows. Concurrent dispatchers must never claim the same row: SQL uses
   * `FOR UPDATE SKIP LOCKED`; an atomic conditional update (e.g. Mongo `findOneAndUpdate` whose
   * filter requires `status = 'pending'`) gives the same skip-the-locked effect.
   */
  claimDue(opts: { limit: number; lockedBy: string; now: Date }): Promise<OutboxRow[]>;

  /**
   * Apply a state transition (a sparse {@link Transition} delta from core/state.ts) to one row.
   * Must be a no-op unless the row is still `in_flight` (idempotency guard) so a late/duplicate
   * worker cannot overwrite a row that was already reclaimed or completed.
   */
  applyTransition(id: string, t: Transition): Promise<void>;

  /**
   * Reclaim stuck locks for at-least-once delivery: every `in_flight` row whose `lockedAt` is
   * older than `now - reclaimAfterMs` returns to `pending` (clearing the lock). Returns the count.
   */
  reclaimStuck(opts: { reclaimAfterMs: number; now: Date }): Promise<number>;

  /** Append one row to the delivery ledger (append-only history of attempts). */
  recordAttempt(attempt: NewDeliveryAttempt): Promise<void>;

  /**
   * dispatch hot path: append the ledger row AND apply the transition in a single round trip,
   * atomically. The ledger insert always happens; the transition keeps the same `in_flight`
   * idempotency guard as {@link Store.applyTransition}. Equivalent to {@link Store.recordAttempt}
   * then {@link Store.applyTransition} but in one DB round trip. SQL adapters use a CTE; a NoSQL
   * backend uses a transaction over the two documents.
   */
  completeAttempt(attempt: NewDeliveryAttempt, transition: Transition): Promise<void>;

  /** Admin: read the ledger for one outbox row, ordered by attempt number. */
  queryAttempts(opts: { outboxId: string }): Promise<DeliveryAttempt[]>;

  /** Admin: select rows matching a replay filter. */
  selectForReplay(filter: ReplayFilter): Promise<OutboxRow[]>;

  /** Admin: persist fresh pending copies for replay (atomically). Returns the new ids. */
  insertReplayCopies(rows: NewOutboxRow[]): Promise<string[]>;

  /** Admin: register a new endpoint (status defaults to `active`). */
  insertEndpoint(ep: NewEndpointRow): Promise<void>;

  /** Admin: patch a registered endpoint; only the provided fields change. No-op patch is a no-op. */
  updateEndpoint(id: string, patch: EndpointPatch): Promise<void>;

  /** Admin: look up a registered endpoint. */
  findEndpoint(id: string): Promise<EndpointRow | null>;

  /** Admin: disable a registered endpoint. */
  disableEndpoint(id: string, now: Date): Promise<void>;

  /** Admin: aggregate queue statistics (status counts and oldest-pending age). */
  stats(): Promise<OutboxStats>;

  /**
   * Startup diagnostics: report whether the backing structures exist. `missingTables` lists the
   * missing backing objects (relational tables, or their NoSQL equivalent such as collections);
   * `ok` is false when a core (non-optional) object is absent.
   */
  diagnose(): Promise<{ ok: boolean; missingTables: string[] }>;

  /** Create/ensure the backing structures (SQL: apply the DDL; NoSQL: create collections/indexes). Idempotent. */
  migrate(): Promise<void>;
}
