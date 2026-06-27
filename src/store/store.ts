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

/**
 * A read-only outbox row for the admin DLQ/list API: an {@link OutboxRow} minus the signing-key
 * snapshot (`secretSnapshot`) so the list surface never exposes secrets, plus the monotonic
 * insertion sequence `seq` used as the pagination cursor. Because no secret column is selected,
 * the encrypted-store decorator passes this through without any decryption.
 */
export interface OutboxListItem {
  id: string;
  eventType: string;
  payload: unknown;
  endpointId: string | null;
  targetUrl: string | null;
  status: Status;
  attempts: number;
  availableAt: Date;
  lockedAt: Date | null;
  lockedBy: string | null;
  idempotencyKey: string | null;
  lastError: string | null;
  createdAt: Date;
  dispatchedAt: Date | null;
  /** Monotonic insertion sequence (bigint rendered as a decimal string); also the list cursor. */
  seq: string;
}

/** Filter/paging options for {@link Store.listOutbox}. All fields optional; newest-first by `seq`. */
export interface OutboxListFilter {
  status?: Status;
  /** Lower bound on `created_at` (inclusive). */
  since?: Date;
  endpointId?: string;
  /** Max rows to return; the store clamps to a safe ceiling. Defaults to 50. */
  limit?: number;
  /** Opaque cursor from a prior page's `nextCursor` (the last `seq` seen). */
  cursor?: string;
}

/**
 * A registered endpoint without its signing secrets: an {@link EndpointRow} minus `secret` and
 * `secretSecondary`, so the list surface never exposes secrets. The encrypted-store decorator
 * passes it through without decryption.
 */
export interface EndpointSummary {
  id: string;
  url: string;
  status: EndpointRow["status"];
  description: string | null;
  consecutiveFailures: number;
  disabledAt: Date | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

/** Filter/paging options for {@link Store.listEndpoints}. Ordered by `id`; cursor is the last id. */
export interface EndpointListFilter {
  status?: EndpointRow["status"];
  /** Max rows to return; the store clamps to a safe ceiling. Defaults to 50. */
  limit?: number;
  /** Opaque cursor from a prior page's `nextCursor` (the last `id` seen). */
  cursor?: string;
}

/** A page of results: the items plus the cursor to pass for the next page (null when exhausted). */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

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
  /** Max rows to replay in one call; the admin layer clamps to a safe ceiling. */
  limit?: number;
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
  /** Secondary signing secret for key rotation; set to a value to dual-sign, or null to finalize. */
  secretSecondary?: string | null;
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
   *
   * `ordering` (default `"none"`, the global-FIFO behaviour) opts into per-endpoint FIFO: at most the
   * single oldest due row per registered endpoint is claimed, and only when no earlier non-terminal
   * row for that endpoint is in flight or awaiting retry — so deliveries to one endpoint stay in
   * order. Inline (null-endpoint) rows are always claimed unordered.
   */
  claimDue(opts: {
    limit: number;
    lockedBy: string;
    now: Date;
    ordering?: "none" | "per-endpoint";
  }): Promise<OutboxRow[]>;

  /**
   * Apply a state transition (a sparse {@link Transition} delta from core/state.ts) to one row.
   * Must be a no-op unless the row is still `in_flight` (idempotency guard) so a late/duplicate
   * worker cannot overwrite a row that was already reclaimed or completed.
   */
  applyTransition(id: string, t: Transition): Promise<void>;

  /**
   * Admin: cancel a not-yet-sent row. Atomically moves it `pending` -&gt; `cancelled` (terminal) only
   * when it is still `pending`; an already-claimed (`in_flight`) or terminal row is left untouched.
   * Returns true when a row was cancelled, false when there was nothing to cancel (so a caller can
   * distinguish "stopped in time" from "already sent / unknown id").
   */
  cancel(id: string): Promise<boolean>;

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
   *
   * `expectedLockedBy` is the worker that claimed the row (the claimed row's `lockedBy`). When
   * non-null it tightens the transition guard to also require `locked_by = expectedLockedBy`, so a
   * row reclaimed and re-locked by another worker (visibility-timeout race under a too-tight
   * `reclaimAfterMs`) cannot be transitioned by the stale worker — its ledger row is still recorded.
   * Pass `null` to keep only the `status = 'in_flight'` guard.
   */
  completeAttempt(
    attempt: NewDeliveryAttempt,
    transition: Transition,
    expectedLockedBy: string | null,
  ): Promise<void>;

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

  /**
   * Admin (read-only): fetch one outbox row by id, secret-free (the signing snapshot is never
   * selected, so the encrypted-store decorator passes it through without decryption). Returns null
   * when the id is unknown.
   */
  getOutbox(id: string): Promise<OutboxListItem | null>;

  /**
   * Circuit breaker: record a successful delivery to a registered endpoint by resetting its
   * `consecutive_failures` to 0. A no-op when the counter is already 0. Called on the delivery hot
   * path, so it must stay cheap and avoid needless writes.
   */
  noteEndpointSuccess(id: string): Promise<void>;

  /**
   * Circuit breaker: record a failed delivery to a registered endpoint. Atomically increments
   * `consecutive_failures` and, when the new count reaches `threshold` while the endpoint is still
   * `active`, disables it (`status = 'disabled'`, `disabled_at = now`) in the same UPDATE.
   */
  noteEndpointFailure(id: string, now: Date, threshold: number): Promise<void>;

  /**
   * Circuit breaker (auto-recovery): re-activate a disabled endpoint after a successful half-open
   * trial delivery. Atomically clears the disabled marker and resets the counter (`status = 'active'`,
   * `consecutive_failures = 0`, `disabled_at = NULL`). A no-op transition for an already-active row.
   */
  reactivateEndpoint(id: string): Promise<void>;

  /**
   * Admin (read-only): page through outbox rows newest-first (by the monotonic `seq`), for DLQ
   * inspection and monitoring. Never returns the signing-key snapshot. Honours the optional
   * status/since/endpointId filters and seq-keyset paging in {@link OutboxListFilter}.
   */
  listOutbox(filter: OutboxListFilter): Promise<Page<OutboxListItem>>;

  /**
   * Admin (read-only): page through registered endpoints (by `id`). Never returns signing secrets.
   * Honours the optional status filter and id-keyset paging in {@link EndpointListFilter}.
   */
  listEndpoints(filter: EndpointListFilter): Promise<Page<EndpointSummary>>;

  /** Admin: disable a registered endpoint. */
  disableEndpoint(id: string, now: Date): Promise<void>;

  /**
   * Admin (retention): delete terminal rows older than `olderThan` (by `created_at`), oldest first,
   * up to `limit` rows. Only the statuses in `statuses` are deleted, which the admin layer constrains
   * to non-active states so a `pending`/`in_flight` row can never be removed out from under a
   * delivery. Each deleted outbox row cascades to its ledger attempts (`ON DELETE CASCADE`). Returns
   * the number of outbox rows deleted; `deleted === limit` means more may remain (call again to page).
   */
  prune(opts: { olderThan: Date; statuses: Status[]; limit: number }): Promise<{ deleted: number }>;

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
