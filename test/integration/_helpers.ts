/**
 * Integration-test harness: spin up a real Postgres via testcontainers and expose both the pg
 * and knex adapters behind a uniform interface so the same suite proves identical semantics
 * (06-testing section 4). Requires Docker; suites skip themselves when it is unavailable.
 */
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Pool, type PoolClient } from "pg";
import knex, { type Knex } from "knex";
import { postgresStore } from "../../src/store/pg";
import { knexStore } from "../../src/store/knex";
import type { Store, NewOutboxRow } from "../../src/store/store";

/** Connection parameters for the started container. */
export interface PgConn {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

/** Best-effort Docker probe so the integration suite can skip cleanly without one. */
export function dockerAvailable(): boolean {
  if (process.env.DOCKER_HOST) return true;
  return existsSync("\\\\.\\pipe\\docker_engine") || existsSync("/var/run/docker.sock");
}

/** The dispatch-path surface of {@link Store} (independent of the transaction-handle type). */
export type DispatchStore = Omit<Store, "insertOutbox">;

/** Uniform per-adapter handle used by the shared suite. */
export interface Harness {
  name: string;
  store: DispatchStore;
  /** Enqueue inside a user transaction; rollback instead of commit when requested. */
  enqueue(row: NewOutboxRow, opts?: { rollback?: boolean }): Promise<void>;
  /** Parameterless raw SQL for assertions/setup (returns snake_case rows). */
  raw(sql: string): Promise<Record<string, unknown>[]>;
  teardown(): Promise<void>;
}

/** Start a disposable Postgres container. */
export async function startPostgres(): Promise<{ conn: PgConn; stop: () => Promise<void> }> {
  const user = "commitcourier";
  const password = "commitcourier";
  const database = "commitcourier";
  const container: StartedTestContainer = await new GenericContainer("postgres:16-alpine")
    .withEnvironment({ POSTGRES_USER: user, POSTGRES_PASSWORD: password, POSTGRES_DB: database })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  const conn: PgConn = {
    host: container.getHost(),
    port: container.getMappedPort(5432),
    user,
    password,
    database,
  };
  return { conn, stop: () => container.stop().then(() => undefined) };
}

/** Sentinel thrown to force a knex transaction to roll back. */
class RollbackSignal extends Error {}

/** pg-backed harness. */
export function pgHarness(conn: PgConn): Harness {
  const pool = new Pool(conn);
  const store = postgresStore({ pool });
  return {
    name: "pg",
    store,
    async enqueue(row, opts) {
      const client: PoolClient = await pool.connect();
      try {
        await client.query("BEGIN");
        await store.insertOutbox(client, row);
        await client.query(opts?.rollback ? "ROLLBACK" : "COMMIT");
      } finally {
        client.release();
      }
    },
    async raw(sql) {
      const res = await pool.query(sql);
      return res.rows as Record<string, unknown>[];
    },
    teardown: () => pool.end(),
  };
}

/** knex-backed harness. */
export function knexHarness(conn: PgConn): Harness {
  const db: Knex = knex({ client: "pg", connection: conn });
  const store = knexStore({ knex: db });
  return {
    name: "knex",
    store,
    async enqueue(row, opts) {
      try {
        await db.transaction(async (trx) => {
          await store.insertOutbox(trx, row);
          if (opts?.rollback) throw new RollbackSignal();
        });
      } catch (err) {
        if (!(err instanceof RollbackSignal)) throw err;
      }
    },
    async raw(sql) {
      const res = (await db.raw(sql)) as unknown as { rows: Record<string, unknown>[] };
      return res.rows;
    },
    teardown: () => db.destroy(),
  };
}

/** Remove all rows between tests (schema stays in place). */
export async function truncateAll(h: Harness): Promise<void> {
  await h.raw(
    "TRUNCATE webhook_delivery_attempts, webhook_outbox, webhook_endpoints RESTART IDENTITY CASCADE",
  );
}

/** Build a minimal valid outbox row for an inline (url) destination. */
export function sampleRow(over: Partial<NewOutboxRow> = {}): NewOutboxRow {
  return {
    id: randomUUID(),
    eventType: "order.created",
    payload: { hello: "world" },
    endpointId: null,
    targetUrl: "https://example.test/hook",
    secretSnapshot: "whsec_test",
    status: "pending",
    attempts: 0,
    availableAt: new Date("2026-06-24T00:00:00.000Z"),
    idempotencyKey: null,
    ...over,
  };
}
