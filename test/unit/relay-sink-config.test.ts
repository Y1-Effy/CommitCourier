/**
 * createRelay wiring for `sink` transport (08-forward-sink section 5): a missing sink fails fast with
 * CONFIG_INVALID, and selecting sink transport warns once that signing/SSRF/circuit breaker are
 * delegated. No Docker; a stub store whose diagnose() is ok is enough.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRelay } from "../../src/relay";
import { RelayError } from "../../src/core/index";
import type { Store, NewOutboxRow } from "../../src/store/store";
import type { Logger } from "../../src/core/index";
import type { Sink } from "../../src/forward/index";

// createRelay only calls store.diagnose() at startup; a stub is enough for the config cases.
function okStore(): Store {
  return { diagnose: () => Promise.resolve({ ok: true, missingTables: [] }) } as unknown as Store;
}

// A store that also captures the row passed to insertOutbox, for the enqueue-path cases.
function captureStore(sink: { row: NewOutboxRow | null }): Store {
  return {
    diagnose: () => Promise.resolve({ ok: true, missingTables: [] }),
    insertOutbox: (_trx: unknown, row: NewOutboxRow) => {
      sink.row = row;
      return Promise.resolve();
    },
  } as unknown as Store;
}

const noopSink: Sink = { deliver: () => Promise.resolve({}) };

function spyLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    debug() {},
    info() {},
    warn: (msg) => void warnings.push(msg),
    error() {},
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createRelay sink-transport wiring", () => {
  it("throws CONFIG_INVALID when transport is sink but no sink is provided", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(
      createRelay({ store: okStore(), delivery: { transport: "sink" } }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("surfaces the failure as a RelayError", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = await createRelay({ store: okStore(), delivery: { transport: "sink" } }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RelayError);
  });

  it("warns that signing/SSRF are delegated when sink transport is selected", async () => {
    const logger = spyLogger();
    await createRelay({
      store: okStore(),
      delivery: { transport: "sink" },
      sink: noopSink,
      logger,
    });
    expect(logger.warnings.some((m) => m.includes("delegates signing"))).toBe(true);
  });

  it("does not warn about delegation for the default http transport", async () => {
    const logger = spyLogger();
    await createRelay({ store: okStore(), logger });
    expect(logger.warnings.some((m) => m.includes("delegates signing"))).toBe(false);
  });

  it("suppresses the plaintext-secret warning in sink mode (no signing secret is used)", async () => {
    const logger = spyLogger();
    await createRelay({
      store: okStore(),
      delivery: { transport: "sink" },
      sink: noopSink,
      logger,
    });
    expect(logger.warnings.some((m) => m.includes("PLAINTEXT"))).toBe(false);
  });
});

describe("custom headers under sink transport", () => {
  // The transport is startup config, but custom headers live on endpoint rows written at runtime, so
  // createRelay cannot see them. The check lands on the admin calls instead — the earliest point where
  // both facts are known, and where the caller is still there to be told.
  function endpointStore(): Store {
    return {
      diagnose: () => Promise.resolve({ ok: true, missingTables: [] }),
      insertEndpoint: () => Promise.resolve(),
      updateEndpoint: () => Promise.resolve(),
    } as unknown as Store;
  }

  async function sinkRelay() {
    return createRelay({
      store: endpointStore(),
      delivery: { transport: "sink" },
      sink: noopSink,
      logger: spyLogger(),
    });
  }

  it("rejects register with custom headers (the sink would never send them)", async () => {
    const relay = await sinkRelay();
    await expect(
      relay.endpoints.register({
        url: "https://x.test/hook",
        secret: "whsec_dGVzdA",
        customHeaders: { authorization: "Bearer t" },
      }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("rejects update with custom headers", async () => {
    const relay = await sinkRelay();
    await expect(
      relay.endpoints.update("ep-1", { customHeaders: { authorization: "Bearer t" } }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("allows register/update without custom headers, so a staged migration is not blocked", async () => {
    const relay = await sinkRelay();
    await expect(
      relay.endpoints.register({ url: "https://x.test/hook", secret: "whsec_dGVzdA" }),
    ).resolves.toMatchObject({ id: expect.any(String) as unknown as string });
    await expect(
      relay.endpoints.update("ep-1", { url: "https://y.test" }),
    ).resolves.toBeUndefined();
  });

  it("allows custom headers under the default http transport", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const relay = await createRelay({ store: endpointStore() });
    await expect(
      relay.endpoints.register({
        url: "https://x.test/hook",
        secret: "whsec_dGVzdA",
        customHeaders: { authorization: "Bearer t" },
      }),
    ).resolves.toMatchObject({ id: expect.any(String) as unknown as string });
  });
});

describe("createRelay sink-transport enqueue (system flow)", () => {
  it("enqueues a target-less row in sink mode without an endpoint", async () => {
    const captured: { row: NewOutboxRow | null } = { row: null };
    const relay = await createRelay({
      store: captureStore(captured),
      delivery: { transport: "sink" },
      sink: noopSink,
      logger: spyLogger(),
    });
    const res = await relay.enqueue({}, { eventType: "order.created", payload: { a: 1 } });
    expect(res.id).toBeTruthy();
    expect(captured.row).not.toBeNull();
    expect(captured.row?.endpointId).toBeNull();
    expect(captured.row?.targetUrl).toBeNull();
    expect(captured.row?.secretSnapshot).toBeNull();
    expect(captured.row?.status).toBe("pending");
  });

  it("still rejects an endpoint-less enqueue in the default http transport", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const relay = await createRelay({ store: captureStore({ row: null }) });
    await expect(
      relay.enqueue({}, { eventType: "order.created", payload: {} }),
    ).rejects.toMatchObject({ code: "ENQUEUE_NO_TARGET" });
  });
});
