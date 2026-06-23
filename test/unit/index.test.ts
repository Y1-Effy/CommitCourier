import { describe, expect, it } from "vitest";
import * as core from "../../src/core/index";

describe("core/index public surface", () => {
  it("re-exports the runtime functions and the error class", () => {
    expect(typeof core.resolveConfig).toBe("function");
    expect(typeof core.sign).toBe("function");
    expect(typeof core.backoffMs).toBe("function");
    expect(typeof core.evaluateIp).toBe("function");
    expect(typeof core.matchHostList).toBe("function");
    expect(typeof core.initialState).toBe("function");
    expect(typeof core.onClaim).toBe("function");
    expect(typeof core.onSuccess).toBe("function");
    expect(typeof core.onFailure).toBe("function");
    expect(typeof core.onReclaim).toBe("function");
    expect(typeof core.utf8ToBytes).toBe("function");
    expect(typeof core.base64ToBytes).toBe("function");
    expect(typeof core.bytesToBase64).toBe("function");
    expect(new core.RelayError("CONFIG_INVALID", "x")).toBeInstanceOf(Error);
  });

  it("the default no-op logger accepts all levels without throwing", () => {
    const { logger } = core.resolveConfig({});
    expect(() => {
      logger.debug("d", { a: 1 });
      logger.info("i");
      logger.warn("w");
      logger.error("e");
    }).not.toThrow();
  });
});
