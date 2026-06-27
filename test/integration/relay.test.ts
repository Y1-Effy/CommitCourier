/**
 * Root API suite (05-admin-api section 9). Drives createRelay/enqueue/replay/endpoints against
 * an in-memory fake Store, so it needs no Docker. Real-DB atomicity is covered by the store and
 * e2e suites.
 */
import { describe, expect, it } from "vitest";
import { createRelay } from "../../src/relay";
import type { EnqueueInput, DeliveryAttempt, OutboxRow } from "../../src/core/index";
import type { Store, NewOutboxRow } from "../../src/store/store";

const NOW = new Date("2026-06-25T00:00:00.000Z");

interface Captured {
  inserted: { trx: unknown; row: NewOutboxRow }[];
  autonomous: NewOutboxRow[];
  replayCopies: NewOutboxRow[];
  disabled: { id: string; now: Date }[];
}

function fakeStore(over: Partial<Store> = {}): { store: Store; captured: Captured } {
  const captured: Captured = { inserted: [], autonomous: [], replayCopies: [], disabled: [] };
  const store: Store = {
    insertOutbox: (trx, row) => {
      captured.inserted.push({ trx, row });
      return Promise.resolve();
    },
    insertOutboxMany: (trx, rows) => {
      for (const row of rows) captured.inserted.push({ trx, row });
      return Promise.resolve();
    },
    insertOutboxAutonomous: (row) => {
      captured.autonomous.push(row);
      return Promise.resolve();
    },
    claimDue: () => Promise.resolve([]),
    applyTransition: () => Promise.resolve(),
    cancel: () => Promise.resolve(false),
    getOutbox: () => Promise.resolve(null),
    prune: () => Promise.resolve({ deleted: 0 }),
    noteEndpointSuccess: () => Promise.resolve(),
    noteEndpointFailure: () => Promise.resolve(),
    reactivateEndpoint: () => Promise.resolve(),
    reclaimStuck: () => Promise.resolve(0),
    recordAttempt: () => Promise.resolve(),
    completeAttempt: () => Promise.resolve(),
    queryAttempts: () => Promise.resolve([]),
    selectForReplay: () => Promise.resolve([]),
    insertReplayCopies: (rows) => {
      captured.replayCopies.push(...rows);
      return Promise.resolve(rows.map((r) => r.id));
    },
    listOutbox: () => Promise.resolve({ items: [], nextCursor: null }),
    listEndpoints: () => Promise.resolve({ items: [], nextCursor: null }),
    insertEndpoint: () => Promise.resolve(),
    updateEndpoint: () => Promise.resolve(),
    findEndpoint: () => Promise.resolve(null),
    disableEndpoint: (id, now) => {
      captured.disabled.push({ id, now });
      return Promise.resolve();
    },
    stats: () =>
      Promise.resolve({
        counts: { pending: 0, in_flight: 0, delivered: 0, dead: 0, observed: 0, cancelled: 0 },
        oldestPendingAt: null,
      }),
    diagnose: () => Promise.resolve({ ok: true, missingTables: [] }),
    migrate: () => Promise.resolve(),
    ...over,
  };
  return { store, captured };
}

const inlineInput = (over: Partial<EnqueueInput> = {}): EnqueueInput => ({
  eventType: "order.created",
  payload: { hello: "world" },
  endpoint: { url: "https://x.test/hook", secret: "whsec_test" },
  ...over,
});

describe("createRelay", () => {
  it("rejects fail-fast when core tables are missing", async () => {
    const { store } = fakeStore({
      diagnose: () => Promise.resolve({ ok: false, missingTables: ["webhook_outbox"] }),
    });
    await expect(createRelay({ store })).rejects.toMatchObject({
      name: "RelayError",
      code: "MISSING_TABLES",
    });
  });

  it("rejects invalid configuration with CONFIG_INVALID", async () => {
    const { store } = fakeStore();
    await expect(createRelay({ store, retry: { maxAttempts: 0 } })).rejects.toMatchObject({
      name: "RelayError",
      code: "CONFIG_INVALID",
    });
  });
});

describe("Relay.enqueue", () => {
  it("rides the given trx and snapshots an inline destination (active -> pending)", async () => {
    const { store, captured } = fakeStore();
    const relay = await createRelay({ store, clock: () => NOW });
    const trx = { marker: 1 };

    const { id } = await relay.enqueue(trx, inlineInput({ idempotencyKey: "idem-1" }));

    expect(captured.inserted).toHaveLength(1);
    const { trx: passedTrx, row } = captured.inserted[0]!;
    expect(passedTrx).toBe(trx);
    expect(row.id).toBe(id);
    expect(row.targetUrl).toBe("https://x.test/hook");
    expect(row.secretSnapshot).toBe("whsec_test");
    expect(row.endpointId).toBeNull();
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.availableAt).toEqual(NOW);
    expect(row.idempotencyKey).toBe("idem-1");
  });

  it("keeps a registered destination with a null secret snapshot", async () => {
    const { store, captured } = fakeStore();
    const relay = await createRelay({ store });

    await relay.enqueue({}, inlineInput({ endpoint: { endpointId: "ep-1" } }));

    const row = captured.inserted[0]!.row;
    expect(row.endpointId).toBe("ep-1");
    expect(row.targetUrl).toBeNull();
    expect(row.secretSnapshot).toBeNull();
  });

  it("records observed (never sent) in observe mode", async () => {
    const { store, captured } = fakeStore();
    const relay = await createRelay({ store, mode: "observe" });

    await relay.enqueue({}, inlineInput());

    expect(captured.inserted[0]!.row.status).toBe("observed");
  });

  it("throws ENQUEUE_NO_TARGET when no destination is provided", async () => {
    const { store } = fakeStore();
    const relay = await createRelay({ store });

    await expect(
      relay.enqueue({}, inlineInput({ endpoint: {} as EnqueueInput["endpoint"] })),
    ).rejects.toMatchObject({ name: "RelayError", code: "ENQUEUE_NO_TARGET" });
  });

  it("throws ENQUEUE_NO_TARGET (not a TypeError) when endpoint is absent", async () => {
    const { store } = fakeStore();
    const relay = await createRelay({ store });

    for (const bad of [undefined, null, "x"]) {
      await expect(
        relay.enqueue({}, inlineInput({ endpoint: bad as unknown as EnqueueInput["endpoint"] })),
      ).rejects.toMatchObject({ name: "RelayError", code: "ENQUEUE_NO_TARGET" });
    }
  });

  it("enqueueUnsafe inserts via the store's own connection", async () => {
    const { store, captured } = fakeStore();
    const relay = await createRelay({ store });

    const { id } = await relay.enqueueUnsafe(inlineInput());

    expect(captured.autonomous).toHaveLength(1);
    expect(captured.autonomous[0]!.id).toBe(id);
  });
});

describe("Relay admin operations", () => {
  it("replay clones matching rows as fresh pending copies inheriting the idempotency key", async () => {
    const dead: OutboxRow = {
      id: "src-1",
      eventType: "order.created",
      payload: { a: 1 },
      endpointId: null,
      targetUrl: "https://x.test/hook",
      secretSnapshot: "whsec_test",
      status: "dead",
      attempts: 12,
      availableAt: NOW,
      lockedAt: null,
      lockedBy: null,
      idempotencyKey: "idem-9",
      lastError: "HTTP 500",
      createdAt: NOW,
      dispatchedAt: null,
    };
    const { store, captured } = fakeStore({ selectForReplay: () => Promise.resolve([dead]) });
    const relay = await createRelay({ store, clock: () => NOW });

    const { ids } = await relay.replay({ filter: { status: "dead" } });

    expect(captured.replayCopies).toHaveLength(1);
    const copy = captured.replayCopies[0]!;
    expect(copy.status).toBe("pending");
    expect(copy.attempts).toBe(0);
    expect(copy.availableAt).toEqual(NOW);
    expect(copy.idempotencyKey).toBe("idem-9");
    expect(copy.targetUrl).toBe("https://x.test/hook");
    expect(copy.id).not.toBe("src-1");
    expect(ids).toEqual([copy.id]);
  });

  it("attempts delegates to the store ledger query", async () => {
    const ledger: DeliveryAttempt[] = [
      {
        id: "a-1",
        outboxId: "o-1",
        attemptNo: 1,
        requestHeaders: { "webhook-id": "o-1" },
        responseStatus: 200,
        responseBodySnippet: "ok",
        durationMs: 5,
        error: null,
        attemptedAt: NOW,
      },
    ];
    const { store } = fakeStore({ queryAttempts: () => Promise.resolve(ledger) });
    const relay = await createRelay({ store });

    expect(await relay.attempts({ outboxId: "o-1" })).toEqual(ledger);
  });

  it("endpoints.disable delegates to the store with the current time", async () => {
    const { store, captured } = fakeStore();
    const relay = await createRelay({ store, clock: () => NOW });

    await relay.endpoints.disable("ep-1");

    expect(captured.disabled).toEqual([{ id: "ep-1", now: NOW }]);
  });
});
