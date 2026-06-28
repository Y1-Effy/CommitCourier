import { afterEach, describe, expect, it, vi } from "vitest";
import { createRelay } from "../../src/relay";
import { RelayError } from "../../src/core/errors";
import type { Store, NewOutboxRow } from "../../src/store/store";

// A stub store is enough: createRelay validates endpointCacheTtlMs before it touches the store.
const stubStore = {} as unknown as Store;

// createRelay only calls store.diagnose() at startup; insertOutbox lets the enqueue path run.
function okStore(captured?: { row: NewOutboxRow | null }): Store {
  return {
    diagnose: () => Promise.resolve({ ok: true, missingTables: [] }),
    insertOutbox: (_trx: unknown, row: NewOutboxRow) => {
      if (captured) captured.row = row;
      return Promise.resolve();
    },
  } as unknown as Store;
}

const inlineEndpoint = { url: "https://example.com/hook", secret: "whsec_test" };

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createRelay endpointCacheTtlMs validation", () => {
  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid endpointCacheTtlMs (%s) with CONFIG_INVALID",
    async (ttl) => {
      const promise = createRelay({ store: stubStore, endpointCacheTtlMs: ttl });
      await expect(promise).rejects.toBeInstanceOf(RelayError);
      await expect(promise).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    },
  );
});

describe("createRelay maxPayloadBytes validation", () => {
  it("rejects a non-positive maxPayloadBytes with CONFIG_INVALID", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const promise = createRelay({ store: stubStore, maxPayloadBytes: 0 });
    await expect(promise).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("enqueue payload validation", () => {
  it("rejects an unserializable payload with ENQUEUE_INVALID_PAYLOAD", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const relay = await createRelay({ store: okStore() });
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(
      relay.enqueue({}, { eventType: "t", payload: circular, endpoint: inlineEndpoint }),
    ).rejects.toMatchObject({ code: "ENQUEUE_INVALID_PAYLOAD" });
  });

  it("rejects an over-size payload when maxPayloadBytes is set", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const relay = await createRelay({ store: okStore(), maxPayloadBytes: 16 });
    await expect(
      relay.enqueue(
        {},
        { eventType: "t", payload: { s: "x".repeat(100) }, endpoint: inlineEndpoint },
      ),
    ).rejects.toMatchObject({ code: "ENQUEUE_INVALID_PAYLOAD" });
  });

  it("allows a large payload when maxPayloadBytes is unset (default off)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const captured: { row: NewOutboxRow | null } = { row: null };
    const relay = await createRelay({ store: okStore(captured) });
    const res = await relay.enqueue(
      {},
      { eventType: "t", payload: { s: "x".repeat(100_000) }, endpoint: inlineEndpoint },
    );
    expect(res.id).toBeTruthy();
    expect(captured.row).not.toBeNull();
  });
});
