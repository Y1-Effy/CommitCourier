/**
 * Persistence abstraction (per 02-store section 2).
 *
 * Only the `enqueue` path uses a user-supplied transaction handle, expressed by the
 * generic `TTx`; adapters bind it to a concrete driver type (pg `PoolClient`,
 * knex `Knex.Transaction`). dispatch-path operations acquire their own connection.
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

/**
 * The persistence port.
 *
 * @typeParam TTx - the transaction-handle type the user passes to {@link Store.insertOutbox}
 * (driver-specific).
 */
export interface Store<TTx = unknown> {
  /** enqueue path: ride the user's TX and INSERT one row (fail-closed). */
  insertOutbox(trx: TTx, row: NewOutboxRow): Promise<void>;

  /** Non-TX enqueue (for enqueueUnsafe): INSERT via the store's own connection. No core guarantee. */
  insertOutboxAutonomous(row: NewOutboxRow): Promise<void>;

  /** dispatch: exclusively claim due rows and move to in_flight (FOR UPDATE SKIP LOCKED). */
  claimDue(opts: { limit: number; lockedBy: string; now: Date }): Promise<OutboxRow[]>;

  /** Apply a state transition (persist a core/state.ts Transition). */
  applyTransition(id: string, t: Transition): Promise<void>;

  /** Reclaim stuck locks: in_flight with lockedAt &lt; now - reclaimAfterMs -&gt; pending. Returns count. */
  reclaimStuck(opts: { reclaimAfterMs: number; now: Date }): Promise<number>;

  /** Append one row to the delivery ledger. */
  recordAttempt(attempt: NewDeliveryAttempt): Promise<void>;

  /** Admin: read the ledger for one outbox row. */
  queryAttempts(opts: { outboxId: string }): Promise<DeliveryAttempt[]>;

  /** Admin: select rows matching a replay filter. */
  selectForReplay(filter: ReplayFilter): Promise<OutboxRow[]>;

  /** Admin: insert fresh pending copies for replay. Returns the new ids. */
  insertReplayCopies(rows: NewOutboxRow[]): Promise<string[]>;

  /** Admin: look up a registered endpoint. */
  findEndpoint(id: string): Promise<EndpointRow | null>;

  /** Admin: disable a registered endpoint. */
  disableEndpoint(id: string, now: Date): Promise<void>;

  /** Startup diagnostics: report whether the core tables exist. */
  diagnose(): Promise<{ ok: boolean; missingTables: string[] }>;

  /** Apply the schema (sql/001_init.sql) in one transaction; idempotent. */
  migrate(): Promise<void>;
}
