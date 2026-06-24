import { describe, expect, it } from "vitest";
import { truncateUtf8 } from "../../src/delivery/http";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

// U+3042 is a 3-byte UTF-8 hiragana; U+FFFD is the replacement character. Built from code
// points so the source stays ASCII-only (lint:lang forbids CJK in .ts).
const HIRAGANA_A = String.fromCharCode(0x3042);
const REPLACEMENT = String.fromCharCode(0xfffd);

describe("truncateUtf8", () => {
  it("returns the whole string when within the limit", () => {
    expect(truncateUtf8(enc("hello"), 100)).toBe("hello");
  });

  it("cuts ASCII exactly at the byte limit", () => {
    expect(truncateUtf8(enc("abcdef"), 3)).toBe("abc");
  });

  it("never splits a multi-byte code point at the boundary", () => {
    const src = enc(HIRAGANA_A.repeat(4)); // 12 bytes
    // Limit 4 lands inside the 2nd char -> rewind to a boundary, keeping just the 1st.
    expect(truncateUtf8(src, 4)).toBe(HIRAGANA_A);
    // Limit 3 is exactly the end of the 1st char.
    expect(truncateUtf8(src, 3)).toBe(HIRAGANA_A);
    // Limit 6 keeps two whole chars.
    expect(truncateUtf8(src, 6)).toBe(HIRAGANA_A.repeat(2));
  });

  it("yields an empty string when not even one code point fits", () => {
    expect(truncateUtf8(enc(HIRAGANA_A), 2)).toBe("");
  });

  it("does not emit a replacement character at the cut", () => {
    expect(truncateUtf8(enc(HIRAGANA_A.repeat(4)), 5)).not.toContain(REPLACEMENT);
  });
});
