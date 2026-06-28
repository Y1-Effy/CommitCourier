/**
 * Accelerator end-to-end (07-accelerator): proves the real Postgres LISTEN/NOTIFY wire — a
 * transactional `signal` reaches a `subscribe` listener, and a dispatcher wired with the accelerator
 * delivers an enqueued row. Also asserts the v2 migration version table. Requires Docker; skips
 * cleanly without one.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client, type Pool } from "pg";
import { postgresStore } from "../../src/store/pg";
import { createPgAccelerator } from "../../src/accelerator/pg";
import { createDispatcher } from "../../src/dispatcher/dispatcher";
import { resolveConfig } from "../../src/core/index";
import type { OutboxRow } from "../../src/core/index";
import { dockerAvailable, newPgPool, startPostgres, sampleRow, type PgConn } from "./_helpers";

describe.skipIf(!dockerAvailable())("accelerator (integration)", () => {
  let stop: () => Promise<void>;
  let conn: PgConn;
  let pool: Pool;
  let store: ReturnType<typeof postgresStore>;

  beforeAll(async () => {
    const started = await startPostgres();
    conn = started.conn;
    stop = started.stop;
    pool = newPgPool(conn);
    store = postgresStore({ pool });
    await store.migrate();
  });

  afterAll(async () => {
    await pool.end();
    await stop();
  });

  function makeAccelerator() {
    return createPgAccelerator({
      pool,
      listen: async () => {
        const c = new Client(conn);
        await c.connect();
        return c;
      },
    });
  }

  it("records the v1 schema in the migration version table (idempotent)", async () => {
    const first = await pool.query("SELECT name FROM commitcourier_migrations ORDER BY name");
    expect(first.rows.map((r: { name: string }) => r.name)).toContain("001_init");
    await store.migrate(); // re-run must not duplicate
    const second = await pool.query("SELECT count(*)::int AS n FROM commitcourier_migrations");
    expect((second.rows[0] as { n: number }).n).toBe(first.rowCount);
  });

  it("delivers a transactional NOTIFY to a subscribed listener", async () => {
    const accelerator = makeAccelerator();
    let woke = 0;
    const unsubscribe = await accelerator.subscribe(() => {
      woke += 1;
    });
    try {
      await accelerator.signalAutonomous();
      await waitFor(() => woke > 0, 3000);
      expect(woke).toBeGreaterThan(0);
    } finally {
      unsubscribe();
    }
  });

  it("wakes a dispatcher so an enqueued row is delivered", async () => {
    const accelerator = makeAccelerator();
    const delivered: string[] = [];
    let resolveDone: () => void = () => {};
    const done = new Promise<void>((r) => {
      resolveDone = r;
    });
    const deliver = (row: OutboxRow): Promise<void> => {
      delivered.push(row.id);
      resolveDone();
      return Promise.resolve();
    };
    const dispatcher = createDispatcher({
      store,
      deliver,
      config: resolveConfig({}),
      // A long poll interval makes the point: if delivery happens, the accelerator (not polling)
      // drove it. The first claim is near-immediate, so this mainly proves the wiring is intact.
      options: { pollIntervalMs: 60_000, reclaimAfterMs: 600_000, concurrency: 2 },
      wakeSignal: (onWake) => accelerator.subscribe(onWake),
    });
    await dispatcher.start();
    try {
      const row = sampleRow();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await store.insertOutbox(client, row);
        await accelerator.signal(client);
        await client.query("COMMIT");
      } finally {
        client.release();
      }
      await Promise.race([done, rejectAfter(10_000, "row was not delivered in time")]);
      expect(delivered).toContain(row.id);
    } finally {
      await dispatcher.stop();
    }
  });
});

/** Poll `cond` until true or the timeout elapses. */
async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A promise that rejects after `ms` (used to bound a wait). */
function rejectAfter(ms: number, message: string): Promise<never> {
  return new Promise((_resolve, reject) => setTimeout(() => reject(new Error(message)), ms));
}
