/**
 * Shared delivery error reduction (src/delivery/_error.ts). These helpers back the ledger's
 * secret-free `error` column, so the key guarantee is that a raw message (which may embed a
 * secret) is replaced by a stable code whenever one is available.
 */
import { describe, expect, it } from "vitest";
import { errorCode, secretFreeSummary } from "../../src/delivery/_error";

describe("errorCode", () => {
  it("returns a string code property", () => {
    expect(errorCode(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe("ECONNRESET");
  });

  it("returns undefined when code is absent", () => {
    expect(errorCode(new Error("x"))).toBeUndefined();
  });

  it("ignores a non-string code (e.g. numeric errno)", () => {
    expect(errorCode(Object.assign(new Error("x"), { code: 111 }))).toBeUndefined();
  });

  it("returns undefined for non-objects", () => {
    expect(errorCode("boom")).toBeUndefined();
    expect(errorCode(null)).toBeUndefined();
  });
});

describe("secretFreeSummary", () => {
  it("prefers the stable code over the message", () => {
    const err = Object.assign(new Error("connect to whsec_supersecret@db failed"), {
      code: "ECONNREFUSED",
    });
    const summary = secretFreeSummary(err);
    expect(summary).toBe("ECONNREFUSED");
    expect(summary).not.toContain("whsec_supersecret");
  });

  it("falls back to the message when there is no code", () => {
    expect(secretFreeSummary(new Error("boom"))).toBe("boom");
  });

  it("ignores a non-string code and uses the message", () => {
    expect(secretFreeSummary(Object.assign(new Error("boom"), { code: 42 }))).toBe("boom");
  });

  it("stringifies non-Error throws", () => {
    expect(secretFreeSummary("plain string")).toBe("plain string");
    expect(secretFreeSummary(404)).toBe("404");
  });
});
