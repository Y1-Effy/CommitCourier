/**
 * Admin operability surface (v2.1): cancel/get input validation and the replay safety cap.
 * cancel/get validate the uuid up front so a malformed id fails as a clean INVALID_ARGUMENT
 * rejection rather than a raw Postgres uuid-cast error; replay always clamps its selection limit so
 * a broad filter can never fan out into an unbounded mass re-send, and reports `capped` so a caller
 * can page on. No Docker.
 */
import { describe, expect, it } from "vitest";
import { cancel, enableEndpoint, getOutbox, prune, replay } from "../../src/admin/admin";
import { RelayError } from "../../src/core/errors";
import {
  REPLAY_DEFAULT_LIMIT,
  PRUNE_DEFAULT_LIMIT,
  PRUNE_MAX_LIMIT,
} from "../../src/store/_shared";
import type { Store, OutboxListItem, ReplayFilter } from "../../src/store/store";
import type { OutboxRow } from "../../src/core/types";
import type { Status } from "../../src/core/shared";

const UUID = "11111111-1111-1111-1111-111111111111";
const NOW = new Date("2026-06-27T00:00:00.000Z");

function row(id: string): OutboxRow {
  return {
    id,
    eventType: "order.created",
    payload: { n: 1 },
    endpointId: null,
    targetUrl: "https://x.test/hook",
    secretSnapshot: "whsec_x",
    status: "dead",
    attempts: 12,
    availableAt: NOW,
    lockedAt: null,
    lockedBy: null,
    idempotencyKey: null,
    lastError: "HTTP 500",
    createdAt: NOW,
    dispatchedAt: null,
  };
}

describe("admin.cancel validation", () => {
  it("rejects a non-uuid outboxId before touching the store", async () => {
    const store = { cancel: () => Promise.resolve(true) } as unknown as Store;
    await expect(cancel(store, "garbage")).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });

  it("returns the store's cancelled flag for a valid id", async () => {
    const store = { cancel: (id: string) => Promise.resolve(id === UUID) } as unknown as Store;
    expect(await cancel(store, UUID)).toEqual({ cancelled: true });
  });
});

describe("admin.getOutbox validation", () => {
  it("rejects a non-uuid outboxId before touching the store", async () => {
    const store = { getOutbox: () => Promise.resolve(null) } as unknown as Store;
    await expect(getOutbox(store, "garbage")).rejects.toBeInstanceOf(RelayError);
  });

  it("passes a valid id through to the store", async () => {
    const item = { id: UUID } as OutboxListItem;
    const store = { getOutbox: () => Promise.resolve(item) } as unknown as Store;
    expect(await getOutbox(store, UUID)).toBe(item);
  });
});

describe("admin.prune validation + defaults", () => {
  interface PruneCall {
    olderThan: Date;
    statuses: Status[];
    limit: number;
  }
  function store(): { store: Store; seen: () => PruneCall | undefined } {
    let seen: PruneCall | undefined;
    const s = {
      prune: (opts: PruneCall) => {
        seen = opts;
        return Promise.resolve({ deleted: 7 });
      },
    } as unknown as Store;
    return { store: s, seen: () => seen };
  }

  it("defaults to the terminal statuses and clamps the limit", async () => {
    const { store: s, seen } = store();
    const res = await prune(s, { olderThan: NOW });
    expect(res).toEqual({ deleted: 7 });
    expect(seen()?.statuses).toEqual(["delivered", "dead", "cancelled"]);
    expect(seen()?.limit).toBe(PRUNE_DEFAULT_LIMIT);
  });

  it("clamps an over-large limit to the hard ceiling", async () => {
    const { store: s, seen } = store();
    await prune(s, { olderThan: NOW, limit: PRUNE_MAX_LIMIT + 100 });
    expect(seen()?.limit).toBe(PRUNE_MAX_LIMIT);
  });

  it.each(["pending", "in_flight"] as const)(
    "rejects a non-prunable status (%s) so a live row is never deleted",
    async (bad) => {
      const { store: s } = store();
      await expect(prune(s, { olderThan: NOW, statuses: [bad] })).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    },
  );

  it("rejects a missing/invalid olderThan", async () => {
    const { store: s } = store();
    await expect(prune(s, { olderThan: new Date(Number.NaN) })).rejects.toBeInstanceOf(RelayError);
  });

  it("allows observed to be pruned explicitly", async () => {
    const { store: s, seen } = store();
    await prune(s, { olderThan: NOW, statuses: ["observed"] });
    expect(seen()?.statuses).toEqual(["observed"]);
  });
});

describe("admin.enableEndpoint", () => {
  it("routes through reactivateEndpoint (resets the breaker counter), not a status-only update", async () => {
    const calls = { reactivate: [] as string[], update: 0 };
    const s = {
      reactivateEndpoint: (id: string) => Promise.resolve(void calls.reactivate.push(id)),
      updateEndpoint: () => Promise.resolve(void calls.update++),
    } as unknown as Store;
    await enableEndpoint(s, UUID);
    // Must reset consecutive_failures (reactivateEndpoint), so a breaker-disabled endpoint gets a
    // full failureThreshold budget again instead of a status-only flip that leaves the counter high.
    expect(calls.reactivate).toEqual([UUID]);
    expect(calls.update).toBe(0);
  });
});

describe("admin.replay safety cap", () => {
  it("clamps the selection limit and flags capped=true when the page is full", async () => {
    let seen: ReplayFilter | undefined;
    const full = Array.from({ length: REPLAY_DEFAULT_LIMIT }, (_, i) => row(`r${String(i)}`));
    const store = {
      selectForReplay: (f: ReplayFilter) => {
        seen = f;
        return Promise.resolve(full);
      },
      insertReplayCopies: (rows: { id: string }[]) => Promise.resolve(rows.map((r) => r.id)),
    } as unknown as Store;

    const res = await replay(store, NOW, { filter: { status: "dead" } });
    // The store was asked for at most the default cap.
    expect(seen?.limit).toBe(REPLAY_DEFAULT_LIMIT);
    expect(res.ids).toHaveLength(REPLAY_DEFAULT_LIMIT);
    // A full page means more may remain — signal the caller to continue.
    expect(res.capped).toBe(true);
  });

  it("forwards an endpointId filter to the store so a replay can be scoped to one endpoint", async () => {
    let seen: ReplayFilter | undefined;
    const store = {
      selectForReplay: (f: ReplayFilter) => {
        seen = f;
        return Promise.resolve([]);
      },
      insertReplayCopies: () => Promise.resolve([]),
    } as unknown as Store;

    await replay(store, NOW, { filter: { status: "dead", endpointId: "ep-1" } });
    expect(seen?.endpointId).toBe("ep-1");
    expect(seen?.status).toBe("dead");
  });

  it.each(["pending", "in_flight"] as const)(
    "rejects an explicit active status (%s) so a live row is never duplicated",
    async (bad) => {
      const store = {
        selectForReplay: () => Promise.resolve([]),
        insertReplayCopies: () => Promise.resolve([]),
      } as unknown as Store;
      await expect(replay(store, NOW, { filter: { status: bad } })).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });
    },
  );

  it("reports capped=false for a partial page and copies fresh pending rows", async () => {
    const store = {
      selectForReplay: () => Promise.resolve([row("a"), row("b")]),
      insertReplayCopies: (rows: OutboxRow[]) => {
        // Replayed copies are fresh pending rows that inherit the destination/payload.
        expect(rows.every((r) => r.status === "pending" && r.attempts === 0)).toBe(true);
        return Promise.resolve(rows.map((r) => r.id));
      },
    } as unknown as Store;

    const res = await replay(store, NOW, { outboxId: UUID });
    expect(res.ids).toHaveLength(2);
    expect(res.capped).toBe(false);
  });
});
