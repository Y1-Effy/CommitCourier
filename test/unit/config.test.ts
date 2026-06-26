import { describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../../src/core/config";
import { RelayError } from "../../src/core/errors";
import type { Logger } from "../../src/core/shared";

/** A spying logger together with its `warn` mock, so assertions reference the spy directly. */
function captureLogger(): { logger: Logger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  return { logger: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }, warn };
}

describe("config.resolveConfig defaults", () => {
  it("fills the documented defaults (00-overview section 6)", () => {
    const cfg = resolveConfig({});
    expect(cfg.mode).toBe("active");
    expect(cfg.signing.scheme).toBe("standard-webhooks");
    expect(cfg.retry).toEqual({
      maxAttempts: 12,
      backoff: "exponential",
      baseMs: 1_000,
      capMs: 3_600_000,
      jitter: 0.2,
    });
    expect(cfg.delivery).toEqual({
      timeoutMs: 15_000,
      bodySnippetBytes: 4_096,
      keepAliveTimeoutMs: 10_000,
    });
    expect(cfg.ssrf).toEqual({ blockPrivateRanges: true, allowlist: [], blocklist: [] });
  });

  it("provides a default clock and no-op logger", () => {
    const cfg = resolveConfig({});
    expect(cfg.clock()).toBeInstanceOf(Date);
    expect(() => cfg.logger.info("x")).not.toThrow();
  });

  it("returns a deeply frozen config", () => {
    const cfg = resolveConfig({});
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(Object.isFrozen(cfg.retry)).toBe(true);
    expect(Object.isFrozen(cfg.ssrf)).toBe(true);
    expect(Object.isFrozen(cfg.ssrf.allowlist)).toBe(true);
  });

  it("merges partial overrides without dropping sibling defaults", () => {
    const cfg = resolveConfig({ retry: { maxAttempts: 5 } });
    expect(cfg.retry.maxAttempts).toBe(5);
    expect(cfg.retry.baseMs).toBe(1_000);
  });

  it("copies allowlist/blocklist arrays defensively", () => {
    const allowlist = ["10.0.0.0/8"];
    const cfg = resolveConfig({ ssrf: { allowlist } });
    allowlist.push("evil");
    expect(cfg.ssrf.allowlist).toEqual(["10.0.0.0/8"]);
  });
});

describe("config.resolveConfig validation (fail-fast)", () => {
  it.each([
    ["maxAttempts < 1", { retry: { maxAttempts: 0 } }],
    ["non-integer maxAttempts", { retry: { maxAttempts: 1.5 } }],
    ["jitter above 1", { retry: { jitter: 1.5 } }],
    ["jitter below 0", { retry: { jitter: -0.1 } }],
    ["baseMs <= 0", { retry: { baseMs: 0 } }],
    ["baseMs NaN", { retry: { baseMs: Number.NaN } }],
    ["capMs <= 0", { retry: { capMs: 0 } }],
    ["capMs below baseMs", { retry: { baseMs: 5_000, capMs: 1_000 } }],
    ["timeoutMs <= 0", { delivery: { timeoutMs: 0 } }],
    ["bodySnippetBytes <= 0", { delivery: { bodySnippetBytes: 0 } }],
    ["keepAliveTimeoutMs <= 0", { delivery: { keepAliveTimeoutMs: 0 } }],
    ["connections < 1", { delivery: { connections: 0 } }],
    ["non-integer connections", { delivery: { connections: 2.5 } }],
  ])("throws CONFIG_INVALID for %s", (_label, input) => {
    try {
      resolveConfig(input);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RelayError);
      expect((err as RelayError).code).toBe("CONFIG_INVALID");
    }
  });

  it("rejects an unsupported signing scheme", () => {
    // The type forbids this, but config can be built from untyped runtime input.
    const bad = { signing: { scheme: "hmac-custom" } } as unknown as Record<string, never>;
    expect(() => resolveConfig(bad)).toThrow(RelayError);
  });

  it("rejects an unknown mode", () => {
    const bad = { mode: "dry-run" } as unknown as Record<string, never>;
    expect(() => resolveConfig(bad)).toThrow(RelayError);
  });

  it("rejects an unsupported backoff strategy", () => {
    const bad = { retry: { backoff: "linear" } } as unknown as Record<string, never>;
    expect(() => resolveConfig(bad)).toThrow(RelayError);
  });

  it("accepts the inclusive jitter boundaries 0 and 1", () => {
    expect(resolveConfig({ retry: { jitter: 0 } }).retry.jitter).toBe(0);
    expect(resolveConfig({ retry: { jitter: 1 } }).retry.jitter).toBe(1);
  });

  it("accepts a valid connections cap and keeps it on the resolved config", () => {
    const cfg = resolveConfig({ delivery: { connections: 64 } });
    expect(cfg.delivery.connections).toBe(64);
    expect(cfg.delivery.keepAliveTimeoutMs).toBe(10_000);
  });

  it("leaves connections undefined by default (undici default)", () => {
    expect(resolveConfig({}).delivery.connections).toBeUndefined();
  });
});

describe("config.resolveConfig warnings (dangerous but valid)", () => {
  it("warns when SSRF protection is disabled", () => {
    const { logger, warn } = captureLogger();
    resolveConfig({ ssrf: { blockPrivateRanges: false }, logger });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("blockPrivateRanges"));
  });

  it("warns when backoff saturates the cap before max attempts", () => {
    const { logger, warn } = captureLogger();
    resolveConfig({ retry: { baseMs: 1_000, maxAttempts: 20, capMs: 5_000 }, logger });
    expect(warn).toHaveBeenCalled();
  });

  it("does not warn for the safe defaults", () => {
    const { logger, warn } = captureLogger();
    resolveConfig({ logger });
    expect(warn).not.toHaveBeenCalled();
  });
});
