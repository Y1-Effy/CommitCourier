/**
 * knex adapter. `knexStore({ knex })`.
 *
 * `TTx = Knex.Transaction`: `insertOutbox` runs on the caller's transaction (fail-closed).
 * dispatch-path methods open their own transaction. `knex` is an optional peer dependency (types
 * only; injected).
 *
 * The Store semantics live in {@link createSqlStore}; this adapter only supplies the knex execution
 * seam ({@link SqlExecutor}) and the multi-statement `migrate` protocol. knex binds positional `?`,
 * so each statement's numbered (`$n`) SQL is translated by {@link numberedToQmark} before
 * `knex.raw`. jsonb params are stringified (knex binds them as text against the SQL's `::jsonb`
 * cast), as in the prisma adapter.
 */
import type { Knex } from "knex";
import type { Store } from "./store";
import { createSqlStore, type SqlExecutor } from "./sql-store";
import {
  numberedToQmark,
  applyMigrations,
  migrationScript,
  migrationsTableScript,
  SELECT_APPLIED_MIGRATIONS_SQL,
} from "./_shared";

/** node-postgres Result shape that `knex.raw` resolves to on the pg dialect. */
interface RawResult {
  rows?: unknown[];
  rowCount?: number | null;
}

/**
 * Build a {@link Store} backed by Knex. `enqueue(trx, …)` takes a `Knex.Transaction` so the
 * outbox write rides the caller's transaction (fail-closed); dispatch-path methods open their
 * own transaction off the injected `knex` instance.
 *
 * @param opts - Holds the configured Knex instance (the `knex` peer dependency must be installed).
 * @returns A `Store<Knex.Transaction>` to pass to `createRelay`.
 */
export function knexStore(opts: { knex: Knex }): Store<Knex.Transaction> {
  const { knex } = opts;

  const run = (raw: Knex | Knex.Transaction, sql: string, params: readonly unknown[]) => {
    const t = numberedToQmark(sql, params);
    return raw.raw(t.sql, t.bindings as Knex.RawBinding[]) as unknown as Promise<RawResult>;
  };

  const exec: SqlExecutor<Knex.Transaction> = {
    jsonAsText: true,
    async query<R>(sql: string, params: readonly unknown[]) {
      const res = await run(knex, sql, params);
      return (res.rows ?? []) as R[];
    },
    async execute(sql, params) {
      const res = await run(knex, sql, params);
      return res.rowCount ?? 0;
    },
    async insertOnTx(trx, sql, params) {
      await run(trx, sql, params);
    },
    withTx(fn) {
      return knex.transaction(fn);
    },
  };

  return createSqlStore(exec, async () => {
    await applyMigrations({
      // One multi-statement raw query (advisory lock + DDL) is a single implicit transaction.
      ensureTable: async () => {
        await knex.raw(migrationsTableScript());
      },
      appliedNames: async () => {
        const res = (await knex.raw(SELECT_APPLIED_MIGRATIONS_SQL)) as unknown as {
          rows: { name: string }[];
        };
        return new Set(res.rows.map((r) => r.name));
      },
      // One multi-statement raw query (advisory lock + DDL + record INSERT) is one implicit transaction.
      apply: async (m) => {
        await knex.raw(migrationScript(m));
      },
    });
  });
}
