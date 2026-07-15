/**
 * Dispatcher concurrency/at-least-once suite (06-testing sections 5-6). Real Postgres via
 * testcontainers; self-skips without Docker. Proves the two core guarantees end to end:
 * single delivery across N dispatchers (SKIP LOCKED) and reclaim of a crashed worker's row.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { onSuccess, resolveConfig } from "../../src/core/index";
import { postgresStore } from "../../src/store/pg";
import type { Store } from "../../src/store/store";
import { createDispatcher } from "../../src/dispatcher/dispatcher";
import {
  TRUNCATE_SQL,
  dockerAvailable,
  newPgPool,
  startPostgres,
  type PgConn,
} from "../integration/_helpers";

async function waitFor(cond: () => boolean, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function seedPending(store: Store, id: string): Promise<void> {
  await store.insertOutboxAutonomous({
    id,
    eventType: "order.created",
    payload: { n: 1 },
    endpointId: null,
    targetUrl: "https://x.test/hook",
    secretSnapshot: "s",
    status: "pending",
    attempts: 0,
    availableAt: new Date(Date.now() - 1000),
    idempotencyKey: null,
  });
}

describe.skipIf(!dockerAvailable())("dispatcher concurrency (integration)", () => {
  let conn: PgConn;
  let stop: () => Promise<void>;
  let admin: Pool;
  const pools: Pool[] = [];

  function newStore(): Store {
    const pool = newPgPool(conn);
    pools.push(pool);
    return postgresStore({ pool });
  }

  beforeAll(async () => {
    const started = await startPostgres();
    conn = started.conn;
    stop = started.stop;
    await newStore().migrate();
    admin = newPgPool(conn);
    pools.push(admin);
  });

  // Reset between tests as every other DB suite does. The reclaim test below asserts an exact
  // delivery count, so a row left behind by an earlier failure would fail it too and bury the
  // original cause.
  beforeEach(async () => {
    await admin.query(TRUNCATE_SQL);
  });

  afterAll(async () => {
    for (const p of pools) await p.end();
    await stop();
  });

  it("delivers each due row exactly once across N dispatchers", async () => {
    const seedStore = newStore();
    const ids: string[] = [];
    for (let i = 0; i < 50; i++) {
      const id = randomUUID();
      ids.push(id);
      await seedPending(seedStore, id);
    }

    const counts = new Map<string, number>();
    const config = resolveConfig({});
    const deliver = async (r: { id: string }): Promise<void> => {
      counts.set(r.id, (counts.get(r.id) ?? 0) + 1);
      // Mark delivered so the row leaves the pipeline (guarded on in_flight).
      await seedStore.applyTransition(r.id, onSuccess(new Date()));
    };

    const dispatchers = Array.from({ length: 4 }, () =>
      createDispatcher({
        store: newStore(),
        deliver,
        config,
        options: { concurrency: 4, batchSize: 8, pollIntervalMs: 20 },
      }),
    );
    await Promise.all(dispatchers.map((d) => d.start()));
    await waitFor(() => counts.size === ids.length);
    await Promise.all(dispatchers.map((d) => d.stop()));

    expect(counts.size).toBe(ids.length);
    expect([...counts.values()].every((c) => c === 1)).toBe(true);
  });

  it("per-endpoint FIFO delivers each endpoint's rows strictly in arrival order", async () => {
    const seedStore = newStore();
    const epA = randomUUID();
    const epB = randomUUID();
    await seedStore.insertEndpoint({ id: epA, url: "https://a.test/hook", secret: "s" });
    await seedStore.insertEndpoint({ id: epB, url: "https://b.test/hook", secret: "s" });

    const N = 6;
    const base = Date.now() - 60_000;
    for (let seq = 0; seq < N; seq++) {
      for (const ep of [epA, epB]) {
        await seedStore.insertOutboxAutonomous({
          id: randomUUID(),
          eventType: "order.created",
          payload: { ep, seq },
          endpointId: ep,
          targetUrl: null,
          secretSnapshot: null,
          status: "pending",
          attempts: 0,
          availableAt: new Date(base + seq), // earlier seq => earlier availableAt
          idempotencyKey: null,
        });
      }
    }

    const order: Record<string, number[]> = { [epA]: [], [epB]: [] };
    const config = resolveConfig({});
    const deliver = async (r: { id: string; payload: unknown }): Promise<void> => {
      const p = r.payload as { ep: string; seq: number };
      // Jitter so any concurrent same-endpoint delivery would surface as out-of-order recording.
      await new Promise((res) => setTimeout(res, Math.random() * 15));
      order[p.ep]!.push(p.seq);
      await seedStore.applyTransition(r.id, onSuccess(new Date()));
    };

    // Several dispatchers with concurrency: per-endpoint ordering must hold one in-flight per endpoint.
    const dispatchers = Array.from({ length: 3 }, () =>
      createDispatcher({
        store: newStore(),
        deliver,
        config,
        options: { concurrency: 4, batchSize: 8, pollIntervalMs: 20, ordering: "per-endpoint" },
      }),
    );
    await Promise.all(dispatchers.map((d) => d.start()));
    await waitFor(() => order[epA]!.length === N && order[epB]!.length === N);
    await Promise.all(dispatchers.map((d) => d.stop()));

    const inOrder = Array.from({ length: N }, (_, i) => i);
    expect(order[epA]).toEqual(inOrder);
    expect(order[epB]).toEqual(inOrder);
  });

  it("reclaims a crashed worker's in_flight row and delivers it", async () => {
    const store = newStore();
    const id = randomUUID();
    await seedPending(store, id);
    // Simulate a worker that claimed the row then crashed, leaving a stale lock.
    const pool = newPgPool(conn);
    pools.push(pool);
    await pool.query(
      `UPDATE webhook_outbox SET status='in_flight', locked_at = now() - interval '1 hour', locked_by='dead' WHERE id=$1`,
      [id],
    );

    let delivered = 0;
    const config = resolveConfig({});
    const d = createDispatcher({
      store: newStore(),
      deliver: async (r: { id: string }): Promise<void> => {
        delivered++;
        await store.applyTransition(r.id, onSuccess(new Date()));
      },
      config,
      options: { reclaimAfterMs: 1000, pollIntervalMs: 20 },
    });
    await d.start();
    await waitFor(() => delivered >= 1);
    await d.stop();

    expect(delivered).toBe(1);
  });
});
