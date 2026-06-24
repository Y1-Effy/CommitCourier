/**
 * pg adapter (per 02-store section 3.1). `postgresStore({ pool })`.
 *
 * `TTx = PoolClient`: `insertOutbox` runs on the caller's client and joins the user's TX
 * (fail-closed). dispatch-path methods acquire their own connection from the pool. `pg` is an
 * optional peer dependency, so it is imported for types only and the pool is injected.
 */
import type { Pool, PoolClient } from "pg";
import type { OutboxRow, DeliveryAttempt, EndpointRow, Transition } from "../core/index";
import type { NewOutboxRow, NewDeliveryAttempt, ReplayFilter, Store } from "./store";
import {
  OUTBOX_TABLE,
  ATTEMPTS_TABLE,
  ENDPOINTS_TABLE,
  OUTBOX_COLUMNS,
  ATTEMPT_COLUMNS,
  CLAIM_SQL_PG,
  DIAGNOSE_SQL,
  outboxValues,
  attemptValues,
  transitionColumns,
  mapOutboxRow,
  mapAttemptRow,
  mapEndpointRow,
  diagnoseResult,
  existingFromRow,
  loadInitSql,
  newId,
  type RawOutboxRow,
  type RawAttemptRow,
  type RawEndpointRow,
} from "./_shared";

/** Build `(cols) VALUES ($1, $2, ...)`, casting the named jsonb column to `::jsonb`. */
function insertClause(table: string, columns: readonly string[], jsonColumn: string): string {
  const placeholders = columns
    .map((c, i) => (c === jsonColumn ? `$${String(i + 1)}::jsonb` : `$${String(i + 1)}`))
    .join(", ");
  return `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`;
}

/** Build the dynamic WHERE for {@link ReplayFilter}: `{ sql, params }` (empty when no filter). */
function replayWhere(filter: ReplayFilter): { sql: string; params: unknown[] } {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (filter.outboxId !== undefined) {
    params.push(filter.outboxId);
    conds.push(`id = $${String(params.length)}`);
  }
  if (filter.status !== undefined) {
    params.push(filter.status);
    conds.push(`status = $${String(params.length)}`);
  }
  if (filter.since !== undefined) {
    params.push(filter.since);
    conds.push(`created_at >= $${String(params.length)}`);
  }
  return { sql: conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "", params };
}

const INSERT_OUTBOX_SQL = insertClause(OUTBOX_TABLE, OUTBOX_COLUMNS, "payload");
const INSERT_ATTEMPT_SQL = insertClause(ATTEMPTS_TABLE, ATTEMPT_COLUMNS, "request_headers");

/** Run `fn` inside a BEGIN/COMMIT, rolling back on error and always releasing the client. */
async function withTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    // A failed COMMIT already aborts the TX, so ROLLBACK may itself throw; never let that
    // mask the original error.
    try {
      await client.query("ROLLBACK");
    } catch {
      // ignore: surface the original failure below.
    }
    throw err;
  } finally {
    client.release();
  }
}

async function insertOutboxWith(client: PoolClient, row: NewOutboxRow): Promise<void> {
  await client.query(INSERT_OUTBOX_SQL, outboxValues(row));
}

/**
 * Build a {@link Store} backed by node-postgres (`pg`). `enqueue(trx, …)` takes a `PoolClient` so
 * the outbox write rides the caller's transaction (fail-closed); dispatch-path methods acquire
 * their own connection from the injected pool.
 *
 * @param opts - Holds the `pg.Pool` (the `pg` peer dependency must be installed).
 * @returns A `Store<PoolClient>` to pass to `createRelay`.
 */
export function postgresStore(opts: { pool: Pool }): Store<PoolClient> {
  const { pool } = opts;

  return {
    insertOutbox(client, row) {
      // Ride the caller's TX: any error propagates so the user's TX rolls back (fail-closed).
      return insertOutboxWith(client, row);
    },

    async insertOutboxAutonomous(row) {
      await pool.query(INSERT_OUTBOX_SQL, outboxValues(row));
    },

    async claimDue({ limit, lockedBy, now }) {
      // Single atomic statement: SELECT ... FOR UPDATE SKIP LOCKED then UPDATE to in_flight.
      const res = await pool.query(CLAIM_SQL_PG, [now, limit, lockedBy]);
      return (res.rows as RawOutboxRow[]).map(mapOutboxRow);
    },

    async applyTransition(id, t: Transition) {
      const { columns, values } = transitionColumns(t);
      const set = columns.map((c, i) => `${c} = $${String(i + 2)}`).join(", ");
      // Idempotency guard: only act on a row still held in_flight.
      const sql = `UPDATE ${OUTBOX_TABLE} SET ${set} WHERE id = $1 AND status = 'in_flight'`;
      await pool.query(sql, [id, ...values]);
    },

    async reclaimStuck({ reclaimAfterMs, now }) {
      const cutoff = new Date(now.getTime() - reclaimAfterMs);
      const sql = `UPDATE ${OUTBOX_TABLE} SET status = 'pending', locked_at = NULL, locked_by = NULL WHERE status = 'in_flight' AND locked_at < $1`;
      const res = await pool.query(sql, [cutoff]);
      return res.rowCount ?? 0;
    },

    async recordAttempt(a: NewDeliveryAttempt) {
      await pool.query(INSERT_ATTEMPT_SQL, attemptValues(newId(), a));
    },

    async queryAttempts({ outboxId }): Promise<DeliveryAttempt[]> {
      const sql = `SELECT * FROM ${ATTEMPTS_TABLE} WHERE outbox_id = $1 ORDER BY attempt_no`;
      const res = await pool.query(sql, [outboxId]);
      return (res.rows as RawAttemptRow[]).map(mapAttemptRow);
    },

    async selectForReplay(filter: ReplayFilter): Promise<OutboxRow[]> {
      const where = replayWhere(filter);
      const sql = `SELECT * FROM ${OUTBOX_TABLE} ${where.sql} ORDER BY created_at`;
      const res = await pool.query(sql, where.params);
      return (res.rows as RawOutboxRow[]).map(mapOutboxRow);
    },

    async insertReplayCopies(rows): Promise<string[]> {
      return withTx(pool, async (client) => {
        for (const row of rows) {
          await insertOutboxWith(client, row);
        }
        return rows.map((r) => r.id);
      });
    },

    async findEndpoint(id): Promise<EndpointRow | null> {
      const res = await pool.query(`SELECT * FROM ${ENDPOINTS_TABLE} WHERE id = $1`, [id]);
      const row = (res.rows as RawEndpointRow[])[0];
      return row ? mapEndpointRow(row) : null;
    },

    async disableEndpoint(id, now) {
      const sql = `UPDATE ${ENDPOINTS_TABLE} SET status = 'disabled', disabled_at = $2 WHERE id = $1`;
      await pool.query(sql, [id, now]);
    },

    async diagnose() {
      const res = await pool.query(DIAGNOSE_SQL);
      const row = (res.rows as Record<string, unknown>[])[0] ?? {};
      return diagnoseResult(existingFromRow(row));
    },

    async migrate() {
      const sql = loadInitSql();
      await withTx(pool, async (client) => {
        await client.query(sql);
      });
    },
  };
}
