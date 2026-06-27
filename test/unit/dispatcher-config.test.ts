/**
 * Dispatcher config hardening (v1.2 review): `createDispatcher` warns when `reclaimAfterMs` is not
 * safely above `delivery.timeoutMs`, since that misconfiguration lets an in-flight delivery be
 * reclaimed and double-delivered (the at-least-once safety invariant). No store I/O at construction,
 * so a `{}` stub store is enough. No Docker.
 */
import { describe, expect, it, vi } from "vitest";
import { createDispatcher } from "../../src/dispatcher/dispatcher";
import { resolveConfig } from "../../src/core/index";
import type { Store } from "../../src/store/store";

const stubStore = {} as unknown as Store;
const deliver = (): Promise<void> => Promise.resolve();

function configWithWarn() {
  const warn = vi.fn();
  // Default delivery.timeoutMs is 15_000, so the safety boundary is 22_500 (1.5x).
  const config = resolveConfig({ logger: { debug() {}, info() {}, warn, error() {} } });
  const reclaimWarnings = (): unknown[][] =>
    warn.mock.calls.filter((c) => String(c[0]).includes("reclaimAfterMs"));
  return { config, warn, reclaimWarnings };
}

describe("createDispatcher reclaimAfterMs vs delivery.timeoutMs", () => {
  it("warns when reclaimAfterMs is not safely above delivery.timeoutMs", () => {
    const { config, warn } = configWithWarn();
    createDispatcher({ store: stubStore, deliver, config, options: { reclaimAfterMs: 2_000 } });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("reclaimAfterMs is not safely above delivery.timeoutMs"),
      expect.objectContaining({ reclaimAfterMs: 2_000, timeoutMs: 15_000 }),
    );
  });

  it("warns at the 1.5x boundary (reclaimAfterMs == timeoutMs * 1.5)", () => {
    const { config, reclaimWarnings } = configWithWarn();
    createDispatcher({ store: stubStore, deliver, config, options: { reclaimAfterMs: 22_500 } });
    expect(reclaimWarnings()).toHaveLength(1);
  });

  it("does not warn for the safe default reclaimAfterMs (300s)", () => {
    const { config, reclaimWarnings } = configWithWarn();
    createDispatcher({ store: stubStore, deliver, config });
    expect(reclaimWarnings()).toHaveLength(0);
  });
});
