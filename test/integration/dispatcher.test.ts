/**
 * Dispatcher loop suite (04-dispatcher, 06-testing sections 5-7 minus the DB-concurrency parts).
 * Uses an in-memory fake Store and a stub deliver, so it needs no Docker and runs in-process.
 */
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { RelayError, resolveConfig } from "../../src/core/index";
import type { OutboxRow, Logger } from "../../src/core/index";
import type { Store } from "../../src/store/store";
import { createDispatcher } from "../../src/dispatcher/dispatcher";
import type { Dispatcher } from "../../src/dispatcher/dispatcher";

const running: Dispatcher[] = [];

afterEach(async () => {
  while (running.length > 0) {
    await running.pop()?.stop();
  }
});

function track(d: Dispatcher): Dispatcher {
  running.push(d);
  return d;
}

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

function row(): OutboxRow {
  return {
    id: randomUUID(),
    eventType: "e",
    payload: {},
    endpointId: null,
    targetUrl: "https://x.test/",
    secretSnapshot: "s",
    status: "in_flight",
    attempts: 0,
    availableAt: new Date(),
    lockedAt: new Date(),
    lockedBy: "w",
    idempotencyKey: null,
    lastError: null,
    createdAt: new Date(),
    dispatchedAt: null,
  };
}

interface ClaimCall {
  limit: number;
  lockedBy: string;
}

/** Fake Store whose claimDue drains a queue; records claim calls and reclaim count. */
function queueStore(seed: OutboxRow[]): {
  store: Store;
  claims: ClaimCall[];
  reclaims: () => number;
  remaining: () => number;
} {
  const queue = [...seed];
  const claims: ClaimCall[] = [];
  let reclaims = 0;
  const store: Store = {
    insertOutbox: () => Promise.resolve(),
    insertOutboxMany: () => Promise.resolve(),
    insertOutboxAutonomous: () => Promise.resolve(),
    claimDue: ({ limit, lockedBy }) => {
      claims.push({ limit, lockedBy });
      return Promise.resolve(queue.splice(0, limit));
    },
    applyTransition: () => Promise.resolve(),
    reclaimStuck: () => {
      reclaims++;
      return Promise.resolve(0);
    },
    recordAttempt: () => Promise.resolve(),
    completeAttempt: () => Promise.resolve(),
    queryAttempts: () => Promise.resolve([]),
    selectForReplay: () => Promise.resolve([]),
    insertReplayCopies: () => Promise.resolve([]),
    listOutbox: () => Promise.resolve({ items: [], nextCursor: null }),
    listEndpoints: () => Promise.resolve({ items: [], nextCursor: null }),
    insertEndpoint: () => Promise.resolve(),
    updateEndpoint: () => Promise.resolve(),
    findEndpoint: () => Promise.resolve(null),
    disableEndpoint: () => Promise.resolve(),
    stats: () =>
      Promise.resolve({
        counts: { pending: 0, in_flight: 0, delivered: 0, dead: 0, observed: 0, cancelled: 0 },
        oldestPendingAt: null,
      }),
    diagnose: () => Promise.resolve({ ok: true, missingTables: [] }),
    migrate: () => Promise.resolve(),
  };
  return { store, claims, reclaims: () => reclaims, remaining: () => queue.length };
}

function spyLogger(errors: string[]): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (msg) => errors.push(msg),
  };
}

describe("createDispatcher", () => {
  it("drains the queue, delivering each claimed row once with a stable lockedBy", async () => {
    const seed = Array.from({ length: 5 }, row);
    const fake = queueStore(seed);
    const config = resolveConfig({});
    const delivered: string[] = [];

    const d = track(
      createDispatcher({
        store: fake.store,
        deliver: (r) => {
          delivered.push(r.id);
          return Promise.resolve();
        },
        config,
        options: { batchSize: 3, pollIntervalMs: 10 },
      }),
    );
    await d.start();
    await waitFor(() => delivered.length === 5);

    expect([...delivered].sort()).toEqual(seed.map((r) => r.id).sort());
    expect(fake.claims[0]?.limit).toBe(3);
    expect(fake.claims[0]?.lockedBy).toMatch(/.+:\d+:[0-9a-f]+/);
    expect(fake.reclaims()).toBeGreaterThan(0);
    expect(d.isRunning()).toBe(true);
  });

  it("rejects misconfigured options fail-fast", () => {
    const fake = queueStore([]);
    const config = resolveConfig({});
    const make = (options: { batchSize?: number; concurrency?: number }): void => {
      createDispatcher({ store: fake.store, deliver: () => Promise.resolve(), config, options });
    };
    expect(() => make({ batchSize: 0 })).toThrow(RelayError);
    expect(() => make({ concurrency: 0 })).toThrow(RelayError);
  });

  it("ticks again immediately on a full batch (adaptive backpressure)", async () => {
    const seed = Array.from({ length: 9 }, row);
    const fake = queueStore(seed);
    const config = resolveConfig({});
    const delivered: string[] = [];

    const started = Date.now();
    const d = track(
      createDispatcher({
        store: fake.store,
        deliver: (r) => {
          delivered.push(r.id);
          return Promise.resolve();
        },
        config,
        // Large idle interval: if full batches slept, draining 9 would take >1s.
        options: { batchSize: 3, pollIntervalMs: 1000 },
      }),
    );
    await d.start();
    await waitFor(() => delivered.length === 9);

    expect(Date.now() - started).toBeLessThan(500);
  });

  it("does not let one slow delivery stall the others (continuous dispatch)", async () => {
    const seed = Array.from({ length: 20 }, row);
    const slowId = seed[0]!.id; // claimed first; holds a single slot until released
    const fake = queueStore(seed);
    const config = resolveConfig({});
    const delivered: string[] = [];
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((r) => (releaseSlow = r));

    const d = track(
      createDispatcher({
        store: fake.store,
        deliver: async (r) => {
          if (r.id === slowId) await slowGate;
          delivered.push(r.id);
        },
        config,
        options: { concurrency: 4, batchSize: 4, pollIntervalMs: 5 },
      }),
    );
    await d.start();

    // A batch barrier would block the whole batch behind the slow row; continuous dispatch keeps
    // the other 19 flowing while the slow one occupies just one slot.
    await waitFor(() => delivered.length >= 19);
    expect(delivered).not.toContain(slowId);

    releaseSlow();
    await waitFor(() => delivered.length === 20);
    expect(delivered).toContain(slowId);
  });

  it("idles without busy-spinning when the queue is empty", async () => {
    const fake = queueStore([]);
    const config = resolveConfig({});
    const d = track(
      createDispatcher({
        store: fake.store,
        deliver: () => Promise.resolve(),
        config,
        options: { pollIntervalMs: 50 },
      }),
    );
    await d.start();
    await new Promise((r) => setTimeout(r, 220));

    // ~50ms interval over ~220ms => a handful of polls, not a tight loop.
    expect(fake.claims.length).toBeLessThan(10);
  });

  it("waits for in-flight deliveries to finish on stop()", async () => {
    const fake = queueStore([row()]);
    const config = resolveConfig({});
    let started = false;
    let finished = false;

    const d = track(
      createDispatcher({
        store: fake.store,
        deliver: async () => {
          started = true;
          await new Promise((r) => setTimeout(r, 60));
          finished = true;
        },
        config,
        options: { pollIntervalMs: 10 },
      }),
    );
    await d.start();
    await waitFor(() => started);

    const claimsAtStop = fake.claims.length;
    await d.stop();

    expect(finished).toBe(true);
    expect(d.isRunning()).toBe(false);
    // No new claims after stop resolved.
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.claims.length).toBe(claimsAtStop);
  });

  it("stays fail-open when claimDue throws, then resumes", async () => {
    const seed = [row()];
    const queue = [...seed];
    const errors: string[] = [];
    let firstCall = true;
    const store: Store = {
      ...queueStore([]).store,
      claimDue: () => {
        if (firstCall) {
          firstCall = false;
          return Promise.reject(new Error("db blip"));
        }
        return Promise.resolve(queue.splice(0, 100));
      },
    };
    const config = resolveConfig({ logger: spyLogger(errors) });
    const delivered: string[] = [];

    const d = track(
      createDispatcher({
        store,
        deliver: (r) => {
          delivered.push(r.id);
          return Promise.resolve();
        },
        config,
        options: { pollIntervalMs: 10 },
      }),
    );
    await d.start();
    await waitFor(() => delivered.length === 1);

    expect(errors.some((e) => e.includes("claim failed"))).toBe(true);
    expect(delivered).toEqual(seed.map((r) => r.id));
  });
});
