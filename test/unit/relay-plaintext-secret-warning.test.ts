/**
 * createRelay warns at startup when signing secrets would be stored in plaintext (no `cipher`),
 * symmetric to the no-logger warning. The warning is silenced by an explicit acknowledgement
 * (`unsafeAllowPlaintextSecrets: true`) or by providing a `cipher`, and routes to a configured logger
 * instead of the console. No Docker; a stub store whose diagnose() is ok is enough.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRelay } from "../../src/relay";
import type { Store } from "../../src/store/store";
import type { Logger, SecretCipher } from "../../src/core/index";

// createRelay only calls store.diagnose() at startup; a stub is enough for these cases.
function okStore(): Store {
  return { diagnose: () => Promise.resolve({ ok: true, missingTables: [] }) } as unknown as Store;
}

// Never exercised at startup (no enqueue/delivery happens), so encrypt/decrypt are inert.
const dummyCipher: SecretCipher = {
  encrypt: (s) => Promise.resolve(s),
  decrypt: (s) => Promise.resolve(s),
};

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

describe("createRelay plaintext-secret startup warning", () => {
  it("warns on the console when no cipher, no acknowledgement, no logger", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await createRelay({ store: okStore() });
    const plaintext = warn.mock.calls.filter((c) => String(c[0]).includes("PLAINTEXT"));
    expect(plaintext).toHaveLength(1);
  });

  it("is silenced by unsafeAllowPlaintextSecrets: true", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await createRelay({ store: okStore(), unsafeAllowPlaintextSecrets: true });
    // The no-logger warning may still fire; only the plaintext-secret warning must be gone.
    const plaintext = warn.mock.calls.filter((c) => String(c[0]).includes("PLAINTEXT"));
    expect(plaintext).toHaveLength(0);
  });

  it("is silenced by providing a cipher", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await createRelay({ store: okStore(), cipher: dummyCipher });
    const plaintext = warn.mock.calls.filter((c) => String(c[0]).includes("PLAINTEXT"));
    expect(plaintext).toHaveLength(0);
  });

  it("routes to the configured logger, not the console", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logger = spyLogger();
    await createRelay({ store: okStore(), logger });
    expect(logger.warnings.some((m) => m.includes("PLAINTEXT"))).toBe(true);
    const plaintextOnConsole = warn.mock.calls.filter((c) => String(c[0]).includes("PLAINTEXT"));
    expect(plaintextOnConsole).toHaveLength(0);
  });
});
