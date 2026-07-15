/**
 * Custom-header validation (core, pure). Locks the two entry points that share one rule set:
 * `validateCustomHeaders` (fail-closed at registration) and `sanitizeCustomHeaders` (silent
 * defence-in-depth on the delivery path).
 */
import { describe, expect, it } from "vitest";
// Imported from the module, not the core barrel: these are internal to the package by design.
import {
  validateCustomHeaders,
  sanitizeCustomHeaders,
  MAX_CUSTOM_HEADERS,
  MAX_CUSTOM_HEADERS_BYTES,
} from "../../src/core/headers";
import { RelayError } from "../../src/core/index";

/** Assert the call throws INVALID_ARGUMENT (the admin-argument code), not some other RelayError. */
function expectInvalid(fn: () => unknown): RelayError {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(RelayError);
  const err = caught as RelayError;
  expect(err.code).toBe("INVALID_ARGUMENT");
  return err;
}

describe("validateCustomHeaders", () => {
  it("accepts an auth header and lowercases the name", () => {
    expect(validateCustomHeaders({ Authorization: "Bearer abc123" })).toEqual({
      authorization: "Bearer abc123",
    });
  });

  it("accepts several headers, including ones the delivery path does not set", () => {
    expect(
      validateCustomHeaders({
        "X-Api-Key": "k1",
        "user-agent": "acme/1.0",
        "x-tenant-id": "t-42",
      }),
    ).toEqual({ "x-api-key": "k1", "user-agent": "acme/1.0", "x-tenant-id": "t-42" });
  });

  it("rejects a non-object, an array and a null", () => {
    expectInvalid(() => validateCustomHeaders("nope"));
    expectInvalid(() => validateCustomHeaders(["a", "b"]));
    expectInvalid(() => validateCustomHeaders(null));
  });

  it("rejects a non-string value", () => {
    expectInvalid(() => validateCustomHeaders({ "x-a": 1 }));
    expectInvalid(() => validateCustomHeaders({ "x-a": null }));
  });

  it("rejects a malformed header name", () => {
    expectInvalid(() => validateCustomHeaders({ "x a": "v" }));
    expectInvalid(() => validateCustomHeaders({ "x:a": "v" }));
    expectInvalid(() => validateCustomHeaders({ "x@a": "v" }));
    expectInvalid(() => validateCustomHeaders({ "": "v" }));
  });

  it("reserves the whole webhook- namespace, not just today's three headers", () => {
    expectInvalid(() => validateCustomHeaders({ "webhook-id": "v" }));
    expectInvalid(() => validateCustomHeaders({ "webhook-timestamp": "v" }));
    expectInvalid(() => validateCustomHeaders({ "webhook-signature": "v" }));
    // Case-insensitively, and for a header Standard Webhooks has not invented yet.
    expectInvalid(() => validateCustomHeaders({ "Webhook-Signature": "v" }));
    expectInvalid(() => validateCustomHeaders({ "webhook-future-thing": "v" }));
  });

  it("reserves the headers the delivery path sets and the hop-by-hop/framing headers", () => {
    for (const name of [
      "content-type",
      "idempotency-key",
      "content-length",
      "Host",
      "transfer-encoding",
      "connection",
      "expect",
      "proxy-authorization",
    ]) {
      expectInvalid(() => validateCustomHeaders({ [name]: "v" }));
    }
  });

  it("rejects CR/LF, NUL, control and non-ASCII characters in a value", () => {
    // Header injection: a CRLF would end the header and start a forged one.
    expectInvalid(() => validateCustomHeaders({ "x-a": "v\r\nX-Injected: yes" }));
    expectInvalid(() => validateCustomHeaders({ "x-a": "v\n" }));
    expectInvalid(() => validateCustomHeaders({ "x-a": "v\0" }));
    expectInvalid(() => validateCustomHeaders({ "x-a": "v\x07" }));
    // Non-ASCII: legal per RFC as obs-text but latin-1 on the wire, so it would mangle silently.
    expectInvalid(() => validateCustomHeaders({ "x-a": "café" }));
  });

  it("rejects an empty value and surrounding whitespace rather than repairing them", () => {
    expectInvalid(() => validateCustomHeaders({ "x-a": "" }));
    expectInvalid(() => validateCustomHeaders({ "x-a": " v" }));
    expectInvalid(() => validateCustomHeaders({ "x-a": "v " }));
    expectInvalid(() => validateCustomHeaders({ "x-a": "v\t" }));
  });

  it("rejects two names that collide once lowercased instead of silently dropping one", () => {
    const err = expectInvalid(() => validateCustomHeaders({ "X-Foo": "1", "x-foo": "2" }));
    expect(err.message).toContain("duplicate");
  });

  it("rejects more than MAX_CUSTOM_HEADERS entries", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i <= MAX_CUSTOM_HEADERS; i++) many[`x-h${String(i)}`] = "v";
    expect(Object.keys(many)).toHaveLength(MAX_CUSTOM_HEADERS + 1);
    expectInvalid(() => validateCustomHeaders(many));
  });

  it("accepts exactly MAX_CUSTOM_HEADERS entries", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < MAX_CUSTOM_HEADERS; i++) many[`x-h${String(i)}`] = "v";
    expect(Object.keys(validateCustomHeaders(many))).toHaveLength(MAX_CUSTOM_HEADERS);
  });

  it("rejects a map over the byte ceiling", () => {
    const err = expectInvalid(() =>
      validateCustomHeaders({ "x-big": "a".repeat(MAX_CUSTOM_HEADERS_BYTES + 1) }),
    );
    expect(err.message).toContain("size limit");
  });

  it("names the offending header in the message", () => {
    const err = expectInvalid(() => validateCustomHeaders({ "X-Bad": "v\r\n" }));
    expect(err.message).toContain("X-Bad");
  });
});

describe("sanitizeCustomHeaders", () => {
  it("returns an empty map for null", () => {
    expect(sanitizeCustomHeaders(null)).toEqual({});
  });

  it("passes valid headers through, lowercased", () => {
    expect(sanitizeCustomHeaders({ "X-Api-Key": "k1" })).toEqual({ "x-api-key": "k1" });
  });

  it("never throws on input that validate would reject", () => {
    expect(() => sanitizeCustomHeaders({ "bad name": "v\r\n", "x-ok": "v" })).not.toThrow();
  });

  it("drops a reserved name that only differs in case", () => {
    // The bypass this exists for: undici lowercases on the wire, so `Webhook-Signature` would arrive
    // as a second `webhook-signature` and leave the receiver's verification undefined.
    expect(
      sanitizeCustomHeaders({ "Webhook-Signature": "forged", "Content-Type": "text/plain" }),
    ).toEqual({});
  });

  it("drops only the offending headers and keeps the rest", () => {
    expect(sanitizeCustomHeaders({ "webhook-id": "x", "x-keep": "v", "x-bad": "v\n" })).toEqual({
      "x-keep": "v",
    });
  });

  it("keeps the first of two names that collide once lowercased", () => {
    expect(sanitizeCustomHeaders({ "X-Foo": "1", "x-foo": "2" })).toEqual({ "x-foo": "1" });
  });

  it("caps the number of headers", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < MAX_CUSTOM_HEADERS + 5; i++) many[`x-h${String(i)}`] = "v";
    expect(Object.keys(sanitizeCustomHeaders(many))).toHaveLength(MAX_CUSTOM_HEADERS);
  });
});
