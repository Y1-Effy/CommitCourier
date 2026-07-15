import { afterEach, describe, expect, it, vi } from "vitest";
import { createConsoleLogger } from "../../src/core/shared";
import { createRelay } from "../../src/relay";
import type { Store } from "../../src/store/store";

describe("createConsoleLogger", () => {
  afterEach(() => vi.restoreAllMocks());

  it("maps each level to the matching console method with a prefix", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const logger = createConsoleLogger();
    logger.debug("d");
    logger.info("i", { a: 1 });
    logger.warn("w");
    logger.error("e", { b: 2 });

    expect(log).toHaveBeenCalledWith("[commitcourier] d");
    expect(info).toHaveBeenCalledWith("[commitcourier] i", { a: 1 });
    expect(warn).toHaveBeenCalledWith("[commitcourier] w");
    expect(error).toHaveBeenCalledWith("[commitcourier] e", { b: 2 });
  });

  it("honours a custom prefix", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    createConsoleLogger("svc").warn("hi");
    expect(warn).toHaveBeenCalledWith("[svc] hi");
  });
});

describe("createRelay unset-logger warning", () => {
  afterEach(() => vi.restoreAllMocks());

  // A stub whose diagnose rejects: createRelay emits the warning before it ever touches the store,
  // so the (expected) later rejection does not affect what we assert about the warning.
  const stubStore = {
    diagnose: () => Promise.reject(new Error("stub")),
  } as unknown as Store;

  it("warns once when no logger is configured", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Match the stub's own rejection: proves createRelay reached diagnose rather than bailing out
    // earlier for an unrelated reason, which would change what the warning below means.
    await expect(createRelay({ store: stubStore })).rejects.toThrow("stub");
    const relayWarnings = warn.mock.calls.filter((c) =>
      String(c[0]).includes("no logger configured"),
    );
    expect(relayWarnings).toHaveLength(1);
  });

  it("does not warn when a logger is provided", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(createRelay({ store: stubStore, logger: createConsoleLogger() })).rejects.toThrow(
      "stub",
    );
    const relayWarnings = warn.mock.calls.filter((c) =>
      String(c[0]).includes("no logger configured"),
    );
    expect(relayWarnings).toHaveLength(0);
  });
});
