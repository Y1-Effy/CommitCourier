import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64, utf8ToBytes } from "../../src/core/encoding";

describe("encoding", () => {
  it("round-trips bytes through base64", () => {
    const bytes = new Uint8Array([0, 1, 2, 127, 128, 200, 255]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it("encodes utf-8 multibyte sequences", () => {
    // U+1F600 grinning face emoji -> 4 UTF-8 bytes.
    const bytes = utf8ToBytes("\u{1F600}");
    expect(Array.from(bytes)).toEqual([0xf0, 0x9f, 0x98, 0x80]);
  });

  it("matches known base64 of an ASCII string", () => {
    expect(bytesToBase64(utf8ToBytes("hello"))).toBe("aGVsbG8=");
    expect(new TextDecoder().decode(base64ToBytes("aGVsbG8="))).toBe("hello");
  });

  it("handles empty input", () => {
    expect(bytesToBase64(new Uint8Array())).toBe("");
    expect(base64ToBytes("")).toEqual(new Uint8Array());
  });

  it("throws on base64 containing characters outside the alphabet", () => {
    // atob rejects "@" (not a base64 character); the contract is to surface that, not silently truncate.
    expect(() => base64ToBytes("@@@@")).toThrow();
  });

  it("emits and round-trips standard padding for non-3-multiple lengths", () => {
    // length % 3 == 1 -> two pad chars; length % 3 == 2 -> one pad char.
    expect(bytesToBase64(utf8ToBytes("f"))).toBe("Zg==");
    expect(bytesToBase64(utf8ToBytes("fo"))).toBe("Zm8=");
    expect(bytesToBase64(utf8ToBytes("foo"))).toBe("Zm9v"); // exact multiple, no padding
    expect(new TextDecoder().decode(base64ToBytes("Zg=="))).toBe("f");
    expect(new TextDecoder().decode(base64ToBytes("Zm8="))).toBe("fo");
  });

  it("round-trips a large binary buffer without corruption (per-byte loop holds)", () => {
    // Exercises the char-by-char btoa/atob loops at a size well beyond the small fixtures above.
    const bytes = crypto.getRandomValues(new Uint8Array(50_000));
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});
