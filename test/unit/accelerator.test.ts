/**
 * Accelerator seam (07-accelerator): the Postgres LISTEN/NOTIFY adapter, the relay enqueue/dispatcher
 * wiring, and the dispatcher's wake-aware idle backoff — all without Docker (fake pg objects, fake
 * store, fake timers). The real end-to-end NOTIFY latency is covered by the integration suite.
 */
import { EventEmitter } from "node:events";
import { describe, expect, it, vi, afterEach } from "vitest";
import type { Pool, Client } from "pg";
import { createPgAccelerator } from "../../src/accelerator/pg";
import { createDispatcher } from "../../src/dispatcher/dispatcher";
import { createRelay } from "../../src/relay";
import { resolveConfig } from "../../src/core/index";
import type { Store, NewOutboxRow } from "../../src/store/store";
import type { EnqueueInput, OutboxRow } from "../../src/core/index";

// --- fakes ---

class FakeClient extends EventEmitter {
  query = vi.fn((_sql: string, _params?: unknown[]) => Promise.resolve({ rows: [] as unknown[] }));
  end = vi.fn(() => Promise.resolve());
}

function fakePool(): { pool: Pool; query: ReturnType<typeof vi.fn> } {
  const query = vi.fn(() => Promise.resolve({ rows: [] as unknown[] }));
  return { pool: { query } as unknown as Pool, query };
}

const silentLogger = { debug() {}, info() {}, warn: vi.fn(), error() {} };

function fakeStore(over: Partial<Store> = {}): Store {
  return {
    insertOutbox: () => Promise.resolve(),
    insertOutboxMany: () => Promise.resolve(),
    insertOutboxAutonomous: () => Promise.resolve(),
    claimDue: () => Promise.resolve([]),
    reclaimStuck: () => Promise.resolve(0),
    applyTransition: () => Promise.resolve(),
    cancel: () => Promise.resolve(false),
    getOutbox: () => Promise.resolve(null),
    prune: () => Promise.resolve({ deleted: 0 }),
    noteEndpointSuccess: () => Promise.resolve(),
    noteEndpointFailure: () => Promise.resolve(),
    reactivateEndpoint: () => Promise.resolve(),
    recordAttempt: () => Promise.resolve(),
    completeAttempt: () => Promise.resolve({ transitionApplied: true }),
    queryAttempts: () => Promise.resolve([]),
    selectForReplay: () => Promise.resolve([]),
    insertReplayCopies: (rows: NewOutboxRow[]) => Promise.resolve(rows.map((r) => r.id)),
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
    ...over,
  };
}

const inlineInput = (over: Partial<EnqueueInput> = {}): EnqueueInput => ({
  eventType: "order.created",
  payload: { hello: "world" },
  endpoint: { url: "https://x.test/hook", secret: "whsec_test" },
  ...over,
});

afterEach(() => {
  vi.useRealTimers();
  silentLogger.warn.mockReset();
});

// --- createPgAccelerator: signal side ---

describe("createPgAccelerator signal", () => {
  it("issues a transactional pg_notify on the enqueue handle (default channel)", async () => {
    const { pool } = fakePool();
    const acc = createPgAccelerator({
      pool,
      listen: () => Promise.resolve(new FakeClient() as unknown as Client),
    });
    const client = new FakeClient();
    await acc.signal(client as unknown as Parameters<typeof acc.signal>[0]);
    expect(client.query).toHaveBeenCalledWith("SELECT pg_notify($1, '')", ["commitcourier_outbox"]);
  });

  it("uses a custom channel", async () => {
    const { pool } = fakePool();
    const acc = createPgAccelerator({
      pool,
      channel: "my_chan",
      listen: () => Promise.resolve(new FakeClient() as unknown as Client),
    });
    const client = new FakeClient();
    await acc.signal(client as unknown as Parameters<typeof acc.signal>[0]);
    expect(client.query).toHaveBeenCalledWith("SELECT pg_notify($1, '')", ["my_chan"]);
  });

  it("rejects an unsafe channel name", () => {
    const { pool } = fakePool();
    expect(() =>
      createPgAccelerator({
        pool,
        channel: "bad chan;",
        listen: () => Promise.resolve(new FakeClient() as unknown as Client),
      }),
    ).toThrow(/channel/);
  });

  it("rejects a channel longer than 63 bytes (would fail at pg_notify, rolling back the user TX)", () => {
    const { pool } = fakePool();
    expect(() =>
      createPgAccelerator({
        pool,
        channel: "a".repeat(64),
        listen: () => Promise.resolve(new FakeClient() as unknown as Client),
      }),
    ).toThrow(/63/);
  });

  it("signalAutonomous swallows a NOTIFY failure (fail-open) and logs", async () => {
    const query = vi.fn(() => Promise.reject(new Error("boom")));
    const pool = { query } as unknown as Pool;
    const acc = createPgAccelerator({
      pool,
      logger: silentLogger,
      listen: () => Promise.resolve(new FakeClient() as unknown as Client),
    });
    await expect(acc.signalAutonomous()).resolves.toBeUndefined();
    expect(silentLogger.warn).toHaveBeenCalled();
  });
});

// --- createPgAccelerator: listen side ---

describe("createPgAccelerator subscribe", () => {
  it("LISTENs, fires onWake only for its channel, and tears down on unsubscribe", async () => {
    const { pool } = fakePool();
    const client = new FakeClient();
    const acc = createPgAccelerator({
      pool,
      listen: () => Promise.resolve(client as unknown as Client),
    });
    const onWake = vi.fn();
    const unsubscribe = await acc.subscribe(onWake);
    expect(client.query).toHaveBeenCalledWith("LISTEN commitcourier_outbox");

    client.emit("notification", { channel: "other", payload: "" });
    expect(onWake).not.toHaveBeenCalled();
    client.emit("notification", { channel: "commitcourier_outbox", payload: "" });
    expect(onWake).toHaveBeenCalledOnce();

    unsubscribe();
    expect(client.query).toHaveBeenCalledWith("UNLISTEN commitcourier_outbox");
    expect(client.end).toHaveBeenCalled();
  });

  it("fires a self-healing wake when the LISTEN connection drops", async () => {
    vi.useFakeTimers();
    const { pool } = fakePool();
    const client = new FakeClient();
    const acc = createPgAccelerator({
      pool,
      logger: silentLogger,
      listen: () => Promise.resolve(client as unknown as Client),
    });
    const onWake = vi.fn();
    const unsubscribe = await acc.subscribe(onWake);
    client.emit("error", new Error("connection reset"));
    expect(onWake).toHaveBeenCalledOnce(); // re-claim any rows enqueued during the gap
    unsubscribe(); // cancels the pending reconnect timer
  });

  // Regression for the setup-window crash: a live pg Client with no "error" listener crashes the
  // process on a connection-level error. The listener must be attached BEFORE the LISTEN round trip.
  it("attaches an error listener before issuing LISTEN", async () => {
    const { pool } = fakePool();
    const client = new FakeClient();
    let errorListenersAtListen = -1;
    client.query = vi.fn((sql: string) => {
      if (sql.startsWith("LISTEN")) errorListenersAtListen = client.listenerCount("error");
      return Promise.resolve({ rows: [] as unknown[] });
    });
    const acc = createPgAccelerator({
      pool,
      listen: () => Promise.resolve(client as unknown as Client),
    });
    const unsubscribe = await acc.subscribe(vi.fn());
    expect(errorListenersAtListen).toBeGreaterThan(0);
    unsubscribe();
  });

  // Regression for the connection leak: when the LISTEN query fails, the opened client must be
  // closed before reconnecting (otherwise repeated failures leak connections).
  it("closes the client and retries when the LISTEN query fails", async () => {
    vi.useFakeTimers();
    const { pool } = fakePool();
    const clients: FakeClient[] = [];
    let attempts = 0;
    const listen = (): Promise<Client> => {
      attempts += 1;
      const c = new FakeClient();
      if (attempts === 1) c.query = vi.fn(() => Promise.reject(new Error("LISTEN failed")));
      clients.push(c);
      return Promise.resolve(c as unknown as Client);
    };
    const acc = createPgAccelerator({ pool, logger: silentLogger, listen });
    const unsubscribe = await acc.subscribe(vi.fn());
    expect(clients[0]?.end).toHaveBeenCalled(); // closed on LISTEN failure (no leak)
    await vi.advanceTimersByTimeAsync(300); // fire the reconnect backoff (250ms)
    expect(attempts).toBeGreaterThanOrEqual(2); // retried with a fresh connection
    unsubscribe();
  });
});

// --- relay wiring ---

describe("createRelay accelerator wiring", () => {
  // Inferred object of spies (not annotated as the Accelerator interface), so member references are
  // plain properties — `expect(accelerator.signal)` does not trip the unbound-method rule — while the
  // shape still satisfies `Accelerator<unknown>` structurally where createRelay expects it.
  const spyAccelerator = () => ({
    signal: vi.fn((_trx: unknown) => Promise.resolve()),
    signalAutonomous: vi.fn(() => Promise.resolve()),
    subscribe: vi.fn((_onWake: () => void) => Promise.resolve(() => {})),
  });

  it("signals the accelerator on the enqueue TX handle", async () => {
    const accelerator = spyAccelerator();
    const relay = await createRelay({ store: fakeStore(), accelerator });
    const trx = { tag: "tx" };
    await relay.enqueue(trx, inlineInput());
    expect(accelerator.signal).toHaveBeenCalledWith(trx);
  });

  it("signals once for an enqueueMany batch and not at all for an empty batch", async () => {
    const accelerator = spyAccelerator();
    const relay = await createRelay({ store: fakeStore(), accelerator });
    const trx = { tag: "tx" };
    await relay.enqueueMany(trx, [inlineInput(), inlineInput()]);
    expect(accelerator.signal).toHaveBeenCalledTimes(1);
    await relay.enqueueMany(trx, []);
    expect(accelerator.signal).toHaveBeenCalledTimes(1);
  });

  it("never lets a signalAutonomous failure break enqueueUnsafe (fail-open)", async () => {
    const accelerator = spyAccelerator();
    accelerator.signalAutonomous = vi.fn(() => Promise.reject(new Error("down")));
    const relay = await createRelay({ store: fakeStore(), logger: silentLogger, accelerator });
    const res = await relay.enqueueUnsafe(inlineInput());
    expect(typeof res.id).toBe("string");
  });

  it("subscribes every dispatcher it creates", async () => {
    const accelerator = spyAccelerator();
    const relay = await createRelay({ store: fakeStore(), accelerator });
    const d = relay.createDispatcher();
    await d.start();
    expect(accelerator.subscribe).toHaveBeenCalledOnce();
    await d.stop();
  });

  const replaySource = (): OutboxRow => ({
    id: "11111111-1111-1111-1111-111111111111",
    eventType: "order.created",
    payload: { a: 1 },
    endpointId: null,
    targetUrl: "https://x.test/hook",
    secretSnapshot: "whsec_test",
    status: "dead",
    attempts: 12,
    availableAt: new Date(0),
    lockedAt: null,
    lockedBy: null,
    idempotencyKey: null,
    lastError: "HTTP 500",
    createdAt: new Date(0),
    dispatchedAt: null,
  });

  it("wakes the accelerator after a replay inserts fresh pending rows", async () => {
    const accelerator = spyAccelerator();
    const store = fakeStore({ selectForReplay: () => Promise.resolve([replaySource()]) });
    const relay = await createRelay({ store, accelerator });
    await relay.replay({ outboxId: replaySource().id });
    expect(accelerator.signalAutonomous).toHaveBeenCalledOnce();
  });

  it("never lets a post-replay signal failure break replay (fail-open)", async () => {
    const accelerator = spyAccelerator();
    accelerator.signalAutonomous = vi.fn(() => Promise.reject(new Error("down")));
    const store = fakeStore({ selectForReplay: () => Promise.resolve([replaySource()]) });
    const relay = await createRelay({ store, logger: silentLogger, accelerator });
    const res = await relay.replay({ outboxId: replaySource().id });
    expect(res.ids).toHaveLength(1);
  });
});

// --- dispatcher wake mechanism ---

describe("dispatcher wake", () => {
  it("cuts the idle backoff short so a wake triggers an immediate claim", async () => {
    vi.useFakeTimers();
    let claims = 0;
    const store = fakeStore({
      claimDue: () => {
        claims += 1;
        return Promise.resolve([]);
      },
    });
    let captured: (() => void) | undefined;
    const wakeSignal = (onWake: () => void): Promise<() => void> => {
      captured = onWake;
      return Promise.resolve(() => {});
    };
    const d = createDispatcher({
      store,
      deliver: () => Promise.resolve(),
      config: resolveConfig({ logger: silentLogger }),
      options: { pollIntervalMs: 100_000, reclaimAfterMs: 600_000 },
      wakeSignal,
    });
    await d.start();
    await vi.advanceTimersByTimeAsync(1); // let the first claim run, then enter the idle sleep
    const afterFirst = claims;
    expect(afterFirst).toBeGreaterThanOrEqual(1);
    expect(captured).toBeTypeOf("function");

    captured?.(); // wake: abort the idle sleep
    await vi.advanceTimersByTimeAsync(0); // flush the loop continuation (no timer wait)
    expect(claims).toBe(afterFirst + 1);

    await d.stop();
  });

  it("polls unchanged when no wakeSignal is wired (backward compatible)", async () => {
    vi.useFakeTimers();
    let claims = 0;
    const store = fakeStore({
      claimDue: () => {
        claims += 1;
        return Promise.resolve([]);
      },
    });
    const d = createDispatcher({
      store,
      deliver: () => Promise.resolve(),
      config: resolveConfig({ logger: silentLogger }),
      options: { pollIntervalMs: 1_000 },
    });
    await d.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(claims).toBeGreaterThanOrEqual(1);
    await d.stop();
  });
});
