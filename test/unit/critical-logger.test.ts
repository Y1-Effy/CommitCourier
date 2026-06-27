/**
 * The critical-event logger surfaces security (SSRF block) and data-loss (DLQ) events even when no
 * logger was configured. When a logger IS configured it forwards there and never duplicates to the
 * console. No Docker.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCriticalLogger } from "../../src/delivery/critical";
import type { Logger } from "../../src/core/index";

function spyLogger(): Logger & { calls: Array<[keyof Logger, string, unknown]> } {
  const calls: Array<[keyof Logger, string, unknown]> = [];
  return {
    calls,
    debug: (m, meta) => void calls.push(["debug", m, meta]),
    info: (m, meta) => void calls.push(["info", m, meta]),
    warn: (m, meta) => void calls.push(["warn", m, meta]),
    error: (m, meta) => void calls.push(["error", m, meta]),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createCriticalLogger", () => {
  it("falls back to the console with a note when no logger is configured", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = spyLogger();
    const critical = createCriticalLogger(logger, false);

    critical.securityBlocked("ssrf", { id: "a" });
    critical.dataLoss("dlq", { id: "b" });

    // The (no-op) logger still receives the event...
    expect(logger.calls).toEqual([
      ["warn", "ssrf", { id: "a" }],
      ["error", "dlq", { id: "b" }],
    ]);
    // ...and the console fallback fires with the "no logger configured" note.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("no logger configured");
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ id: "a", loggerConfigured: false });
    expect(error.mock.calls[0]?.[1]).toMatchObject({ id: "b", loggerConfigured: false });
  });

  it("forwards to the configured logger only, never the console", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = spyLogger();
    const critical = createCriticalLogger(logger, true);

    critical.securityBlocked("ssrf", { id: "a" });
    critical.dataLoss("dlq", { id: "b" });

    expect(logger.calls).toEqual([
      ["warn", "ssrf", { id: "a" }],
      ["error", "dlq", { id: "b" }],
    ]);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
