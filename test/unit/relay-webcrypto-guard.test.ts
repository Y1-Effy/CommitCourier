/**
 * createRelay's WebCrypto runtime guard: signing needs the `crypto.subtle` global (standard on Node
 * 20+). On a runtime that does not expose it, createRelay must fail fast with a clear RelayError
 * instead of letting every signed delivery throw a cryptic ReferenceError and silently fill the DLQ.
 * The `sink` transport delegates signing, so it is exempt. No Docker; a stub store is enough.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRelay } from "../../src/relay";
import { RelayError } from "../../src/core/index";
import type { Store } from "../../src/store/store";
import type { Logger } from "../../src/core/index";
import type { Sink } from "../../src/forward/index";

// createRelay only calls store.diagnose() at startup; a stub is enough for the config cases.
function okStore(): Store {
  return { diagnose: () => Promise.resolve({ ok: true, missingTables: [] }) } as unknown as Store;
}

const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const noopSink: Sink = { deliver: () => Promise.resolve({}) };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createRelay WebCrypto guard", () => {
  it("fails fast with CONFIG_INVALID when crypto is missing (default http transport)", async () => {
    vi.stubGlobal("crypto", undefined);
    const err = await createRelay({ store: okStore(), logger: noopLogger }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RelayError);
    expect(err).toMatchObject({ code: "CONFIG_INVALID" });
    expect((err as Error).message).toMatch(/WebCrypto/);
  });

  it("checks crypto.subtle specifically, not just the crypto global", async () => {
    // A runtime that exposes `crypto` (e.g. getRandomValues) but no `subtle` still cannot sign.
    vi.stubGlobal("crypto", { getRandomValues: () => new Uint8Array() });
    await expect(createRelay({ store: okStore(), logger: noopLogger })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
  });

  it("does not apply the guard to the sink transport (signing delegated)", async () => {
    vi.stubGlobal("crypto", undefined);
    await expect(
      createRelay({
        store: okStore(),
        delivery: { transport: "sink" },
        sink: noopSink,
        logger: noopLogger,
      }),
    ).resolves.toBeDefined();
  });

  it("resolves normally when WebCrypto is available", async () => {
    await expect(createRelay({ store: okStore(), logger: noopLogger })).resolves.toBeDefined();
  });
});
