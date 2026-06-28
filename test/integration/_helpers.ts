/**
 * Integration-test harness: spin up a real Postgres via testcontainers and expose both the pg
 * and knex adapters behind a uniform interface so the same suite proves identical semantics
 * (06-testing section 4). Requires Docker; suites skip themselves when it is unavailable.
 */
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { Pool, type PoolClient } from "pg";
import knex, { type Knex } from "knex";
import { drizzle } from "drizzle-orm/node-postgres";
import { postgresStore } from "../../src/store/pg";
import { knexStore } from "../../src/store/knex";
import { drizzleStore } from "../../src/store/drizzle";
import { mapOutboxRow, type RawOutboxRow } from "../../src/store/_shared";
import type { Store, NewOutboxRow } from "../../src/store/store";
import type { OutboxRow } from "../../src/core/index";

/** Connection parameters for the started container. */
export interface PgConn {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

let dockerProbe: boolean | undefined;

/**
 * Best-effort Docker probe so the integration suite can skip cleanly without one (cached).
 *
 * The unix socket is a cheap, reliable signal on Linux/macOS (and CI). On Windows, Docker Desktop
 * exposes a named pipe (`\\.\pipe\dockerDesktopLinuxEngine`) that `existsSync` cannot stat, so we
 * fall back to asking the Docker CLI whether a daemon is actually reachable — `docker info` exits
 * non-zero when the daemon is down, which keeps suites skipping (not failing) without Docker.
 */
export function dockerAvailable(): boolean {
  if (dockerProbe !== undefined) return dockerProbe;
  dockerProbe = probeDocker();
  return dockerProbe;
}

function probeDocker(): boolean {
  if (process.env.DOCKER_HOST) return true;
  if (existsSync("/var/run/docker.sock")) return true;
  try {
    execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 15_000,
    });
    return true;
  } catch {
    return false;
  }
}

/** The dispatch-path surface of {@link Store} (independent of the transaction-handle type). */
export type DispatchStore = Omit<Store, "insertOutbox">;

/**
 * Uniform per-adapter handle used by the shared conformance suite. The verification hooks are
 * storage-paradigm-neutral (no SQL in their signatures), so the same suite can drive any backend
 * — SQL or NoSQL — by providing one more `Harness` implementation.
 */
export interface Harness {
  name: string;
  store: DispatchStore;
  /** Enqueue inside a user transaction; rollback instead of commit when requested. */
  enqueue(row: NewOutboxRow, opts?: { rollback?: boolean }): Promise<void>;
  /** Bulk enqueue inside a user transaction (single multi-row INSERT); rollback when requested. */
  enqueueMany(rows: NewOutboxRow[], opts?: { rollback?: boolean }): Promise<void>;
  /** Read one outbox row as the mapped domain shape, or undefined when absent. */
  getOutbox(id: string): Promise<OutboxRow | undefined>;
  /** Force a row into `in_flight` with a specific `lockedAt` (to set up reclaim scenarios). */
  setInFlight(id: string, lockedAt: Date): Promise<void>;
  /** Seed a registered endpoint (no store method creates one). */
  insertEndpoint(ep: { id: string; url: string; secret: string }): Promise<void>;
  /** Remove all rows between tests (backing structures stay in place). */
  reset(): Promise<void>;
  teardown(): Promise<void>;
}

/**
 * Map the first raw row to the domain shape (or undefined). Harnesses read a single row by raw
 * SELECT rather than via `selectForReplay`, which is deliberately restricted to non-active rows and
 * so cannot read a `pending`/`in_flight` row under test.
 */
function mapFirstOutbox(rows: unknown[]): OutboxRow | undefined {
  const row = rows[0] as RawOutboxRow | undefined;
  return row ? mapOutboxRow(row) : undefined;
}

/** Start a disposable Postgres container. */
export async function startPostgres(): Promise<{ conn: PgConn; stop: () => Promise<void> }> {
  const user = "commitcourier";
  const password = "commitcourier";
  const database = "commitcourier";
  // Image is overridable via POSTGRES_IMAGE so CI can exercise the supported version range
  // (e.g. the minimum and latest). Defaults to the version the local suite is developed against.
  const image = process.env.POSTGRES_IMAGE ?? "postgres:16-alpine";
  const container: StartedTestContainer = await new GenericContainer(image)
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

const TRUNCATE_SQL =
  "TRUNCATE webhook_delivery_attempts, webhook_outbox, webhook_endpoints RESTART IDENTITY CASCADE";

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
    async enqueueMany(rows, opts) {
      const client: PoolClient = await pool.connect();
      try {
        await client.query("BEGIN");
        await store.insertOutboxMany(client, rows);
        await client.query(opts?.rollback ? "ROLLBACK" : "COMMIT");
      } finally {
        client.release();
      }
    },
    getOutbox: async (id) =>
      mapFirstOutbox((await pool.query("SELECT * FROM webhook_outbox WHERE id = $1", [id])).rows),
    async setInFlight(id, lockedAt) {
      await pool.query(
        "UPDATE webhook_outbox SET status='in_flight', locked_at=$2, locked_by='test' WHERE id=$1",
        [id, lockedAt],
      );
    },
    async insertEndpoint(ep) {
      await pool.query("INSERT INTO webhook_endpoints (id, url, secret) VALUES ($1, $2, $3)", [
        ep.id,
        ep.url,
        ep.secret,
      ]);
    },
    async reset() {
      await pool.query(TRUNCATE_SQL);
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
    async enqueueMany(rows, opts) {
      try {
        await db.transaction(async (trx) => {
          await store.insertOutboxMany(trx, rows);
          if (opts?.rollback) throw new RollbackSignal();
        });
      } catch (err) {
        if (!(err instanceof RollbackSignal)) throw err;
      }
    },
    getOutbox: async (id) => mapFirstOutbox(await db("webhook_outbox").where({ id }).select("*")),
    async setInFlight(id, lockedAt) {
      await db("webhook_outbox")
        .where({ id })
        .update({ status: "in_flight", locked_at: lockedAt, locked_by: "test" });
    },
    async insertEndpoint(ep) {
      await db("webhook_endpoints").insert({ id: ep.id, url: ep.url, secret: ep.secret });
    },
    async reset() {
      await db.raw(TRUNCATE_SQL);
    },
    teardown: () => db.destroy(),
  };
}

/** drizzle-backed harness (node-postgres). Uses the same pool for raw setup helpers. */
export function drizzleHarness(conn: PgConn): Harness {
  const pool = new Pool(conn);
  const db = drizzle(pool);
  const store = drizzleStore({ db });
  const rollbackIfRequested = async (
    fn: (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<void>,
    rollback?: boolean,
  ): Promise<void> => {
    try {
      await db.transaction(async (tx) => {
        await fn(tx);
        if (rollback) throw new RollbackSignal();
      });
    } catch (err) {
      if (!(err instanceof RollbackSignal)) throw err;
    }
  };
  return {
    name: "drizzle",
    store,
    enqueue: (row, opts) =>
      rollbackIfRequested((tx) => store.insertOutbox(tx, row), opts?.rollback),
    enqueueMany: (rows, opts) =>
      rollbackIfRequested((tx) => store.insertOutboxMany(tx, rows), opts?.rollback),
    getOutbox: async (id) =>
      mapFirstOutbox((await pool.query("SELECT * FROM webhook_outbox WHERE id = $1", [id])).rows),
    async setInFlight(id, lockedAt) {
      await pool.query(
        "UPDATE webhook_outbox SET status='in_flight', locked_at=$2, locked_by='test' WHERE id=$1",
        [id, lockedAt],
      );
    },
    async insertEndpoint(ep) {
      await pool.query("INSERT INTO webhook_endpoints (id, url, secret) VALUES ($1, $2, $3)", [
        ep.id,
        ep.url,
        ep.secret,
      ]);
    },
    async reset() {
      await pool.query(TRUNCATE_SQL);
    },
    teardown: () => pool.end(),
  };
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
