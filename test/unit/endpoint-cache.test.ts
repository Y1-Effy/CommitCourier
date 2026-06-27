import { describe, expect, it, vi, type Mock } from "vitest";
import { createEndpointCache } from "../../src/store/endpoint-cache";
import type { EndpointRow } from "../../src/core/index";
import type { Store } from "../../src/store/store";

function endpointRow(id: string, secret = "whsec_x"): EndpointRow {
  return {
    id,
    url: "https://example.test/hook",
    secret,
    secretSecondary: null,
    status: "active",
    description: null,
    consecutiveFailures: 0,
    disabledAt: null,
    metadata: null,
    createdAt: new Date(0),
  };
}

/** Minimal fake store: findEndpoint is a spy serving a mutable map; other methods are stubs. */
function fakeStore(rows: Record<string, EndpointRow | null>): {
  store: Store;
  findEndpoint: Mock<(id: string) => Promise<EndpointRow | null>>;
  updateEndpoint: Mock<() => Promise<void>>;
  disableEndpoint: Mock<() => Promise<void>>;
} {
  const findEndpoint = vi.fn((id: string) => Promise.resolve(rows[id] ?? null));
  const updateEndpoint = vi.fn(() => Promise.resolve());
  const disableEndpoint = vi.fn(() => Promise.resolve());
  const store = {
    findEndpoint,
    updateEndpoint,
    disableEndpoint,
    noteEndpointSuccess: vi.fn(() => Promise.resolve()),
    noteEndpointFailure: vi.fn(() => Promise.resolve()),
    insertEndpoint: vi.fn(() => Promise.resolve()),
    insertOutbox: () => Promise.resolve(),
    insertOutboxMany: () => Promise.resolve(),
    insertOutboxAutonomous: () => Promise.resolve(),
    insertReplayCopies: () => Promise.resolve([]),
    claimDue: () => Promise.resolve([]),
    selectForReplay: () => Promise.resolve([]),
    applyTransition: () => Promise.resolve(),
    reclaimStuck: () => Promise.resolve(0),
    recordAttempt: () => Promise.resolve(),
    completeAttempt: () => Promise.resolve(),
    queryAttempts: () => Promise.resolve([]),
    stats: () => Promise.resolve({ counts: {} as never, oldestPendingAt: null }),
    diagnose: () => Promise.resolve({ ok: true, missingTables: [] }),
    migrate: () => Promise.resolve(),
  } as unknown as Store;
  return { store, findEndpoint, updateEndpoint, disableEndpoint };
}

describe("createEndpointCache", () => {
  it("serves a cached hit without a second inner lookup", async () => {
    const { store, findEndpoint } = fakeStore({ a: endpointRow("a") });
    const cached = createEndpointCache(store, { ttlMs: 1_000 });
    expect((await cached.findEndpoint("a"))?.id).toBe("a");
    expect((await cached.findEndpoint("a"))?.id).toBe("a");
    expect(findEndpoint).toHaveBeenCalledTimes(1);
  });

  it("refetches after updateEndpoint evicts the entry", async () => {
    const { store, findEndpoint, updateEndpoint } = fakeStore({ a: endpointRow("a") });
    const cached = createEndpointCache(store, { ttlMs: 1_000 });
    await cached.findEndpoint("a");
    await cached.updateEndpoint("a", { secret: "whsec_new" });
    await cached.findEndpoint("a");
    expect(findEndpoint).toHaveBeenCalledTimes(2);
    expect(updateEndpoint).toHaveBeenCalledWith("a", { secret: "whsec_new" });
  });

  it("refetches after disableEndpoint evicts the entry", async () => {
    const { store, findEndpoint } = fakeStore({ a: endpointRow("a") });
    const cached = createEndpointCache(store, { ttlMs: 1_000 });
    await cached.findEndpoint("a");
    await cached.disableEndpoint("a", new Date());
    await cached.findEndpoint("a");
    expect(findEndpoint).toHaveBeenCalledTimes(2);
  });

  it("refetches after noteEndpointFailure evicts (it may trip the breaker to disabled)", async () => {
    const { store, findEndpoint } = fakeStore({ a: endpointRow("a") });
    const cached = createEndpointCache(store, { ttlMs: 10_000 });
    await cached.findEndpoint("a");
    await cached.noteEndpointFailure("a", new Date(), 3);
    await cached.findEndpoint("a");
    expect(findEndpoint).toHaveBeenCalledTimes(2);
  });

  it("does NOT evict on noteEndpointSuccess (runs every delivery; status is unchanged)", async () => {
    const { store, findEndpoint } = fakeStore({ a: endpointRow("a") });
    const cached = createEndpointCache(store, { ttlMs: 10_000 });
    await cached.findEndpoint("a");
    await cached.noteEndpointSuccess("a");
    await cached.findEndpoint("a"); // still served from cache — no second inner read
    expect(findEndpoint).toHaveBeenCalledTimes(1);
  });

  it("refetches after the TTL expires", async () => {
    vi.useFakeTimers();
    try {
      const { store, findEndpoint } = fakeStore({ a: endpointRow("a") });
      const cached = createEndpointCache(store, { ttlMs: 1_000 });
      await cached.findEndpoint("a");
      vi.advanceTimersByTime(1_001);
      await cached.findEndpoint("a");
      expect(findEndpoint).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not cache a value read concurrently with an update (stale-read guard)", async () => {
    const { store, findEndpoint } = fakeStore({ a: endpointRow("a", "whsec_current") });
    // Hold the first read open so an update can race it before it resolves.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    findEndpoint.mockImplementationOnce(async () => {
      await gate;
      return endpointRow("a", "whsec_stale"); // the pre-update row this read observed
    });
    const cached = createEndpointCache(store, { ttlMs: 10_000 });

    const inflight = cached.findEndpoint("a"); // captures generation, then awaits the gate
    await cached.updateEndpoint("a", { secret: "whsec_current" }); // bumps generation, evicts
    release();
    await inflight; // the in-flight read completes but must NOT populate the cache

    const again = await cached.findEndpoint("a");
    // A second inner read proves the racing value was not cached and served from the cache.
    expect(findEndpoint).toHaveBeenCalledTimes(2);
    expect(again?.secret).toBe("whsec_current");
  });

  it("does not cache a miss, so a later insert is visible at once", async () => {
    const rows: Record<string, EndpointRow | null> = { a: null };
    const { store, findEndpoint } = fakeStore(rows);
    const cached = createEndpointCache(store, { ttlMs: 10_000 });
    expect(await cached.findEndpoint("a")).toBeNull();
    rows.a = endpointRow("a"); // simulate a register by another path
    expect((await cached.findEndpoint("a"))?.id).toBe("a");
    expect(findEndpoint).toHaveBeenCalledTimes(2);
  });

  it("passes non-endpoint methods straight through", async () => {
    const { store } = fakeStore({});
    const cached = createEndpointCache(store, { ttlMs: 1_000 });
    await expect(cached.claimDue({ limit: 1, lockedBy: "w", now: new Date() })).resolves.toEqual(
      [],
    );
    await expect(cached.diagnose()).resolves.toEqual({ ok: true, missingTables: [] });
  });
});
