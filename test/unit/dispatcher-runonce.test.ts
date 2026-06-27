/**
 * dispatcher.runOnce (v2.1): a one-shot drain for serverless/cron deployments — claim due rows in
 * waves, deliver them, and resolve once the queue is empty (or maxRows is reached), with no
 * long-lived loop. It reclaims stale locks first by default and refuses to run concurrently with the
 * continuous loop. Fail-open like the loop. No Docker (a fake store drives the waves).
 */
import { describe, expect, it, vi } from "vitest";
import { createDispatcher } from "../../src/dispatcher/dispatcher";
import { resolveConfig } from "../../src/core/index";
import { RelayError } from "../../src/core/errors";
import type { OutboxRow } from "../../src/core/types";
import type { Store } from "../../src/store/store";

function makeRow(id: string): OutboxRow {
  return {
    id,
    eventType: "e",
    payload: {},
    endpointId: null,
    targetUrl: "https://x.test/h",
    secretSnapshot: "whsec_x",
    status: "pending",
    attempts: 0,
    availableAt: new Date(0),
    lockedAt: null,
    lockedBy: null,
    idempotencyKey: null,
    lastError: null,
    createdAt: new Date(0),
    dispatchedAt: null,
  };
}

function fakeStore(total: number): { store: Store; reclaims: () => number; claims: () => number } {
  const queue = Array.from({ length: total }, (_, i) => makeRow(`r${String(i)}`));
  let reclaims = 0;
  let claims = 0;
  const store = {
    reclaimStuck: () => {
      reclaims++;
      return Promise.resolve(0);
    },
    claimDue: ({ limit }: { limit: number }) => {
      claims++;
      return Promise.resolve(queue.splice(0, limit));
    },
  } as unknown as Store;
  return { store, reclaims: () => reclaims, claims: () => claims };
}

const config = resolveConfig({});

describe("dispatcher.runOnce", () => {
  it("drains the whole queue across waves and reports the processed count", async () => {
    const delivered: string[] = [];
    const { store, reclaims } = fakeStore(25);
    const d = createDispatcher({
      store,
      deliver: (row) => Promise.resolve(void delivered.push(row.id)),
      config,
      options: { concurrency: 4, batchSize: 8 },
    });

    const res = await d.runOnce();

    expect(res.processed).toBe(25);
    expect(delivered).toHaveLength(25);
    expect(new Set(delivered).size).toBe(25); // every row delivered exactly once
    expect(reclaims()).toBe(1); // reclaim runs once by default
  });

  it("skips the reclaim sweep when reclaim:false", async () => {
    const { store, reclaims } = fakeStore(3);
    const d = createDispatcher({ store, deliver: () => Promise.resolve(), config });
    await d.runOnce({ reclaim: false });
    expect(reclaims()).toBe(0);
  });

  it("stops at maxRows without draining the rest", async () => {
    const delivered: string[] = [];
    const { store } = fakeStore(100);
    const d = createDispatcher({
      store,
      deliver: (row) => Promise.resolve(void delivered.push(row.id)),
      config,
      options: { concurrency: 4, batchSize: 8 },
    });
    const res = await d.runOnce({ maxRows: 10 });
    expect(res.processed).toBe(10);
    expect(delivered).toHaveLength(10);
  });

  it("is fail-open: a delivery that rejects does not abort the drain", async () => {
    const { store } = fakeStore(5);
    const logger = { debug() {}, info() {}, warn() {}, error: vi.fn() };
    const d = createDispatcher({
      store,
      deliver: (row) => (row.id === "r2" ? Promise.reject(new Error("boom")) : Promise.resolve()),
      config: resolveConfig({ logger }),
      options: { concurrency: 2, batchSize: 4 },
    });
    const res = await d.runOnce();
    expect(res.processed).toBe(5); // all dispatched despite one rejection
    expect(logger.error).toHaveBeenCalled();
  });

  it("refuses to run while the continuous loop is active", async () => {
    const { store } = fakeStore(0);
    const d = createDispatcher({ store, deliver: () => Promise.resolve(), config });
    await d.start();
    try {
      await expect(d.runOnce()).rejects.toMatchObject({
        code: "CONFIG_INVALID",
      });
      await expect(d.runOnce()).rejects.toBeInstanceOf(RelayError);
    } finally {
      await d.stop();
    }
  });
});
