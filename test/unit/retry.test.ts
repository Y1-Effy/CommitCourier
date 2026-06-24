import { describe, expect, it } from "vitest";
import { backoffMs } from "../../src/core/retry";
import type { RetryConfig } from "../../src/core/types";

const cfg: RetryConfig = {
  maxAttempts: 12,
  backoff: "exponential",
  baseMs: 1_000,
  capMs: 3_600_000,
  jitter: 0.2,
};

describe("retry.backoffMs", () => {
  it("is exponential with jitter disabled (rnd does not matter when jitter=0)", () => {
    const noJitter: RetryConfig = { ...cfg, jitter: 0 };
    expect(backoffMs(1, noJitter, () => 0.5)).toBe(1_000);
    expect(backoffMs(2, noJitter, () => 0)).toBe(2_000);
    expect(backoffMs(3, noJitter, () => 0.999)).toBe(4_000);
  });

  it("caps the raw exponential value at capMs", () => {
    const noJitter: RetryConfig = { ...cfg, jitter: 0, capMs: 5_000 };
    // 2^10 * 1000 would be ~1M, but cap is 5000.
    expect(backoffMs(11, noJitter, () => 0.5)).toBe(5_000);
  });

  it("stays at capMs when 2^(attempts-1) overflows to Infinity", () => {
    // 2 ** 1099 is Infinity; Math.min(Infinity, capMs) must collapse to capMs (no NaN/crash).
    const noJitter: RetryConfig = { ...cfg, jitter: 0 };
    expect(backoffMs(1_100, noJitter, () => 0.5)).toBe(cfg.capMs);
  });

  it("applies the full negative jitter at rnd()=0", () => {
    // attempts=1 -> capped=1000, span=200, delta=(0*2-1)*200=-200 -> 800
    expect(backoffMs(1, cfg, () => 0)).toBe(800);
  });

  it("applies the full positive jitter at rnd() approaching 1", () => {
    // delta = (1*2-1)*200 = +200 -> 1200
    expect(backoffMs(1, cfg, () => 1)).toBe(1_200);
  });

  it("never returns a negative value", () => {
    const big: RetryConfig = { ...cfg, jitter: 1, baseMs: 10 };
    expect(backoffMs(1, big, () => 0)).toBeGreaterThanOrEqual(0);
  });

  it("defaults rnd to Math.random and stays within the jitter band", () => {
    const v = backoffMs(1, cfg);
    expect(v).toBeGreaterThanOrEqual(800);
    expect(v).toBeLessThanOrEqual(1_200);
  });
});
