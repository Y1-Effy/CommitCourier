/**
 * Drizzle adapter. `drizzleStore({ db })`.
 *
 * `TTx = DrizzleTx` (a drizzle node-postgres transaction): `insertOutbox` runs on the caller's
 * drizzle transaction and joins the user's TX (fail-closed). Drizzle sits on node-postgres, so the
 * adapter reuses the exact Postgres dialect SQL and the shared Store semantics ({@link createSqlStore}).
 *
 * Execution seam: drizzle's `execute` overrides node-postgres' type parsers and returns timestamps as
 * raw strings (it maps them in its ORM layer, which we bypass). So row-reading dispatch/admin methods
 * run through the underlying `$client` (node-postgres' default parsers → `Date`), exactly like the pg
 * adapter; only the enqueue-path writes — which bind params and read no rows — use the drizzle
 * transaction handle so they ride the caller's transaction. `drizzle-orm` is an optional peer
 * dependency (types only; the db is injected).
 */
import { sql, type SQL } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Store } from "./store";
import { createSqlStore, type SqlExecutor } from "./sql-store";
import {
  applyMigrations,
  migrationScript,
  migrationsTableScript,
  SELECT_APPLIED_MIGRATIONS_SQL,
} from "./_shared";

/** The node-postgres client surface (`Pool` or `Client`) drizzle exposes as `$client`. */
type PgClient = {
  query(text: string, params?: unknown[]): Promise<{ rows?: unknown[]; rowCount?: number | null }>;
};

/** A drizzle node-postgres database, plus the `$client` exposed by the `drizzle()` factory. */
export type DrizzleDb = NodePgDatabase & { $client: PgClient };

/** The transaction handle drizzle passes to a `db.transaction` callback (the `enqueue` TTx). */
export type DrizzleTx = Parameters<Parameters<DrizzleDb["transaction"]>[0]>[0];

/** The drizzle executor surface used for enqueue-path writes (satisfied by {@link DrizzleTx}). */
type Executor = { execute(query: SQL): Promise<unknown> };

/**
 * Turn a numbered (`$1`, `$2`, …) SQL string and its ordered params into a drizzle `SQL` object.
 * Each `$n` occurrence binds `params[n-1]` as its own parameter (a reused `$1` simply binds the same
 * value again), so the shared dialect SQL — including its reused `now` slots — works unchanged. Only
 * used for enqueue-path writes on the caller's transaction (which read no rows).
 */
function toSql(numbered: string, params: readonly unknown[]): SQL {
  const chunks: SQL[] = [];
  const re = /\$(\d+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(numbered)) !== null) {
    if (m.index > last) chunks.push(sql.raw(numbered.slice(last, m.index)));
    chunks.push(sql`${params[Number(m[1]) - 1]}`);
    last = m.index + m[0].length;
  }
  if (last < numbered.length) chunks.push(sql.raw(numbered.slice(last)));
  return sql.join(chunks);
}

/**
 * Build a {@link Store} backed by Drizzle (node-postgres). `enqueue(trx, …)` takes a drizzle
 * transaction so the outbox write rides the caller's transaction (fail-closed); dispatch/admin
 * methods run on the underlying `$client`. Semantics match the `pg` adapter (same dialect SQL and
 * driver-level type parsing).
 *
 * @param opts - Holds the drizzle database (built with `drizzle(pool)`, so `$client` is present).
 * @returns A `Store<DrizzleTx>` to pass to `createRelay`.
 */
export function drizzleStore(opts: { db: DrizzleDb }): Store<DrizzleTx> {
  const { db } = opts;
  const client = db.$client;

  // Reads/writes go through `$client` (node-postgres' parsers → Date); only the enqueue-path INSERT
  // rides the caller's drizzle transaction via `tx.execute(toSql(...))`. jsonAsText: pre-stringify jsonb
  // params (like pg) so top-level JSON scalars/null/arrays round-trip — node-postgres' native param
  // encoding maps null → SQL NULL and mis-encodes a bare string/array, which `::jsonb` then rejects.
  const exec: SqlExecutor<DrizzleTx> = {
    jsonAsText: true,
    async query<R>(text: string, params: readonly unknown[]) {
      const res = await client.query(text, params as unknown[]);
      return (res.rows ?? []) as R[];
    },
    async execute(text, params) {
      const res = await client.query(text, params as unknown[]);
      return res.rowCount ?? 0;
    },
    async insertOnTx(trx, text, params) {
      await (trx as Executor).execute(toSql(text, params));
    },
    withTx(fn) {
      return db.transaction(fn);
    },
  };

  return createSqlStore(exec, async () => {
    await applyMigrations({
      // The simple query protocol ($client.query with no params) runs a multi-statement script as
      // one implicit transaction (advisory lock + DDL), so concurrent ensureTable calls serialise.
      ensureTable: async () => {
        await client.query(migrationsTableScript());
      },
      appliedNames: async () => {
        const res = await client.query(SELECT_APPLIED_MIGRATIONS_SQL);
        return new Set(((res.rows ?? []) as { name: string }[]).map((r) => r.name));
      },
      // The script is multiple statements; the simple query protocol runs them as one implicit
      // transaction (drizzle's execute uses the extended protocol, which rejects multi-statement).
      // Advisory lock + DDL + record INSERT therefore commit atomically and serialise.
      apply: async (m) => {
        await client.query(migrationScript(m));
      },
    });
  });
}
