/**
 * pg adapter. `postgresStore({ pool })`.
 *
 * `TTx = PoolClient`: `insertOutbox` runs on the caller's client and joins the user's TX
 * (fail-closed). dispatch-path methods acquire their own connection from the pool. `pg` is an
 * optional peer dependency, so it is imported for types only and the pool is injected.
 *
 * The Store semantics live in {@link createSqlStore}; this adapter only supplies the node-postgres
 * execution seam ({@link SqlExecutor}) and the multi-statement `migrate` protocol.
 */
import type { Pool, PoolClient } from "pg";
import type { Store } from "./store";
import { createSqlStore, type SqlExecutor } from "./sql-store";
import {
  applyMigrations,
  migrationScript,
  migrationsTableScript,
  SELECT_APPLIED_MIGRATIONS_SQL,
} from "./_shared";

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

  // node-postgres serialises JS objects to jsonb itself and returns `{ rows, rowCount }`.
  const exec: SqlExecutor<PoolClient> = {
    jsonAsText: false,
    async query<R>(sql: string, params: readonly unknown[]) {
      const res = await pool.query(sql, params as unknown[]);
      return res.rows as R[];
    },
    async execute(sql, params) {
      const res = await pool.query(sql, params as unknown[]);
      return res.rowCount ?? 0;
    },
    async insertOnTx(client, sql, params) {
      await client.query(sql, params as unknown[]);
    },
    withTx(fn) {
      return withTx(pool, fn);
    },
  };

  return createSqlStore(exec, async () => {
    await applyMigrations({
      // One multi-statement simple query (advisory lock + DDL) is a single implicit transaction.
      ensureTable: async () => {
        await pool.query(migrationsTableScript());
      },
      appliedNames: async () => {
        const res = await pool.query(SELECT_APPLIED_MIGRATIONS_SQL);
        return new Set((res.rows as { name: string }[]).map((r) => r.name));
      },
      // One multi-statement simple query (advisory lock + DDL + record INSERT) is one implicit transaction.
      apply: async (m) => {
        await pool.query(migrationScript(m));
      },
    });
  });
}
