/**
 * Per-adapter relay harness for the e2e/fault suites. Wraps createRelay over a real pg or knex
 * store and hides the driver-specific transaction so the same suite can prove identical behaviour
 * on both adapters. The transaction-typed `enqueue` is exposed only through `enqueueCommitted` /
 * `enqueueWithBusiness`; everything else is reached through `api` (TTx-independent).
 */
import { Pool, type PoolClient } from "pg";
import knexLib from "knex";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { postgresStore } from "../../src/store/pg";
import { knexStore } from "../../src/store/knex";
import { drizzleStore } from "../../src/store/drizzle";
import { createRelay } from "../../src/relay";
import type { Relay, RelayInit } from "../../src/relay";
import type { EnqueueInput } from "../../src/core/index";
import type { Store } from "../../src/store/store";
import type { PgConn } from "./_helpers";

/** The relay surface that does not depend on the transaction-handle type. */
export type RelayApi = Omit<Relay<unknown>, "enqueue">;

/** Partial relay configuration (everything except the store). */
export type RelayConfigInit = Omit<RelayInit<unknown>, "store">;

export interface RelayHarness {
  name: string;
  api: RelayApi;
  store: Store;
  /** Enqueue inside a committed business transaction. */
  enqueueCommitted(input: EnqueueInput): Promise<{ id: string }>;
  /** Enqueue alongside a business write in one transaction; commit or roll back atomically. */
  enqueueWithBusiness(
    input: EnqueueInput,
    businessSql: string,
    opts: { rollback: boolean },
  ): Promise<void>;
  /** Parameterless raw read for assertions (snake_case rows). */
  query(sql: string): Promise<Record<string, unknown>[]>;
  teardown(): Promise<void>;
}

/** Sentinel used to force a knex transaction to roll back. */
class Rollback extends Error {}

export async function pgRelay(conn: PgConn, init: RelayConfigInit): Promise<RelayHarness> {
  const pool = new Pool(conn);
  const store = postgresStore({ pool });
  const relay = await createRelay({ store, ...init });
  return {
    name: "pg",
    api: relay,
    store,
    async enqueueCommitted(input) {
      const client: PoolClient = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await relay.enqueue(client, input);
        await client.query("COMMIT");
        return result;
      } finally {
        client.release();
      }
    },
    async enqueueWithBusiness(input, businessSql, opts) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(businessSql);
        await relay.enqueue(client, input);
        await client.query(opts.rollback ? "ROLLBACK" : "COMMIT");
      } finally {
        client.release();
      }
    },
    async query(sql) {
      const res = await pool.query(sql);
      return res.rows as Record<string, unknown>[];
    },
    teardown: () => pool.end(),
  };
}

export async function knexRelay(conn: PgConn, init: RelayConfigInit): Promise<RelayHarness> {
  const db = knexLib({ client: "pg", connection: conn });
  const store = knexStore({ knex: db });
  const relay = await createRelay({ store, ...init });
  return {
    name: "knex",
    api: relay,
    store,
    enqueueCommitted(input) {
      return db.transaction((trx) => relay.enqueue(trx, input));
    },
    async enqueueWithBusiness(input, businessSql, opts) {
      try {
        await db.transaction(async (trx) => {
          await trx.raw(businessSql);
          await relay.enqueue(trx, input);
          if (opts.rollback) throw new Rollback();
        });
      } catch (err) {
        if (!(err instanceof Rollback)) throw err;
      }
    },
    async query(sql) {
      const res = (await db.raw(sql)) as unknown as { rows: Record<string, unknown>[] };
      return res.rows;
    },
    teardown: () => db.destroy(),
  };
}

export async function drizzleRelay(conn: PgConn, init: RelayConfigInit): Promise<RelayHarness> {
  const pool = new Pool(conn);
  const db = drizzle(pool);
  const store = drizzleStore({ db });
  const relay = await createRelay({ store, ...init });
  return {
    name: "drizzle",
    api: relay,
    store,
    enqueueCommitted(input) {
      return db.transaction((tx) => relay.enqueue(tx, input));
    },
    async enqueueWithBusiness(input, businessSql, opts) {
      try {
        await db.transaction(async (tx) => {
          await tx.execute(sql.raw(businessSql));
          await relay.enqueue(tx, input);
          if (opts.rollback) throw new Rollback();
        });
      } catch (err) {
        if (!(err instanceof Rollback)) throw err;
      }
    },
    async query(querySql) {
      const res = await pool.query(querySql);
      return res.rows as Record<string, unknown>[];
    },
    teardown: () => pool.end(),
  };
}

/** The adapters to parametrize a suite over. */
export const RELAY_ADAPTERS: [
  string,
  (conn: PgConn, init: RelayConfigInit) => Promise<RelayHarness>,
][] = [
  ["pg", pgRelay],
  ["knex", knexRelay],
  ["drizzle", drizzleRelay],
];
