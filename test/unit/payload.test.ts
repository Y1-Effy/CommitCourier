import { describe, expect, it } from "vitest";
import { validatePayload } from "../../src/core/payload";
import { RelayError } from "../../src/core/errors";

describe("core.validatePayload serializability", () => {
  it("accepts ordinary JSON values", () => {
    expect(() => validatePayload({ a: 1, b: ["x", true, null], c: { d: 2 } })).not.toThrow();
    expect(() => validatePayload([])).not.toThrow();
    expect(() => validatePayload("string")).not.toThrow();
    expect(() => validatePayload(0)).not.toThrow();
    expect(() => validatePayload(false)).not.toThrow();
    expect(() => validatePayload(null)).not.toThrow();
  });

  it("rejects a circular reference with ENQUEUE_INVALID_PAYLOAD and keeps the cause", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    try {
      validatePayload(circular);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RelayError);
      expect((err as RelayError).code).toBe("ENQUEUE_INVALID_PAYLOAD");
      expect((err as RelayError).cause).toBeInstanceOf(Error);
    }
  });

  it("rejects a BigInt with ENQUEUE_INVALID_PAYLOAD", () => {
    try {
      validatePayload({ big: 10n });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RelayError);
      expect((err as RelayError).code).toBe("ENQUEUE_INVALID_PAYLOAD");
    }
  });

  it.each([
    ["top-level undefined", undefined],
    ["a function", () => 1],
    ["a symbol", Symbol("x")],
  ])("rejects %s that serializes to undefined", (_label, value) => {
    try {
      validatePayload(value);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RelayError);
      expect((err as RelayError).code).toBe("ENQUEUE_INVALID_PAYLOAD");
    }
  });
});

describe("core.validatePayload size limit", () => {
  it("does not enforce a size limit when maxBytes is omitted", () => {
    const big = { s: "x".repeat(10_000) };
    expect(() => validatePayload(big)).not.toThrow();
  });

  it("accepts a payload at the byte limit", () => {
    // JSON.stringify("abc") => "\"abc\"" = 5 bytes.
    expect(() => validatePayload("abc", 5)).not.toThrow();
  });

  it("rejects a payload over the byte limit with ENQUEUE_INVALID_PAYLOAD", () => {
    try {
      validatePayload("abc", 4);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RelayError);
      expect((err as RelayError).code).toBe("ENQUEUE_INVALID_PAYLOAD");
      expect((err as RelayError).message).toContain("maxPayloadBytes");
    }
  });

  it("measures UTF-8 byte length, not character count", () => {
    // U+00E9 is 1 char but 2 UTF-8 bytes; JSON adds 2 quote bytes => 4 bytes total.
    const twoByteChar = String.fromCharCode(0x00e9);
    expect(() => validatePayload(twoByteChar, 4)).not.toThrow();
    expect(() => validatePayload(twoByteChar, 3)).toThrow(RelayError);
  });
});
