/**
 * Endpoint admin validation for custom headers: registration is fail-closed, so a bad header is an
 * INVALID_ARGUMENT the caller sees rather than something silently dropped at delivery time. Locks the
 * normalisation that reaches the store, and that a rejection arrives through the returned Promise.
 * No Docker (the store is faked).
 */
import { describe, expect, it } from "vitest";
import { registerEndpoint, updateEndpoint } from "../../src/admin/admin";
import type { EndpointAdminContext } from "../../src/admin/admin";
import type { EndpointStore, NewEndpointRow, EndpointPatch } from "../../src/store/store";

const HTTP: EndpointAdminContext = { transport: "http" };

interface Recorder {
  store: EndpointStore;
  inserted: NewEndpointRow[];
  patched: EndpointPatch[];
}

function recorder(): Recorder {
  const inserted: NewEndpointRow[] = [];
  const patched: EndpointPatch[] = [];
  const store = {
    insertEndpoint: (ep: NewEndpointRow) => Promise.resolve(void inserted.push(ep)),
    updateEndpoint: (_id: string, patch: EndpointPatch) =>
      Promise.resolve(void patched.push(patch)),
  } as unknown as EndpointStore;
  return { store, inserted, patched };
}

const base = { url: "https://x.test/hook", secret: "whsec_dGVzdA" };

describe("registerEndpoint custom headers", () => {
  it("stores the normalised (lowercased) map", async () => {
    const rec = recorder();
    await registerEndpoint(
      rec.store,
      { ...base, customHeaders: { Authorization: "Bearer t" } },
      HTTP,
    );
    expect(rec.inserted[0]?.customHeaders).toEqual({ authorization: "Bearer t" });
  });

  it("stores null when no custom headers are given", async () => {
    const rec = recorder();
    await registerEndpoint(rec.store, base, HTTP);
    expect(rec.inserted[0]?.customHeaders).toBeNull();
  });

  it("rejects a reserved header rather than dropping it at delivery time", async () => {
    const rec = recorder();
    await expect(
      registerEndpoint(rec.store, { ...base, customHeaders: { "webhook-signature": "x" } }, HTTP),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(rec.inserted).toHaveLength(0);
  });

  it("rejects a CRLF in a value", async () => {
    const rec = recorder();
    await expect(
      registerEndpoint(rec.store, { ...base, customHeaders: { "x-a": "v\r\nX-I: y" } }, HTTP),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(rec.inserted).toHaveLength(0);
  });
});

describe("updateEndpoint custom headers", () => {
  it("validates and normalises the patched map", async () => {
    const rec = recorder();
    await updateEndpoint(rec.store, "ep-1", { customHeaders: { "X-Api-Key": "k1" } }, HTTP);
    expect(rec.patched[0]?.customHeaders).toEqual({ "x-api-key": "k1" });
  });

  it("passes a null patch through to clear the map", async () => {
    const rec = recorder();
    await updateEndpoint(rec.store, "ep-1", { customHeaders: null }, HTTP);
    expect(rec.patched[0]?.customHeaders).toBeNull();
  });

  it("leaves an unrelated patch alone", async () => {
    const rec = recorder();
    await updateEndpoint(rec.store, "ep-1", { url: "https://y.test" }, HTTP);
    expect(rec.patched[0]).toEqual({ url: "https://y.test" });
  });

  it("rejects through the returned Promise, never synchronously", () => {
    const rec = recorder();
    // If this threw synchronously the expression itself would throw before expect() ran.
    const p = updateEndpoint(rec.store, "ep-1", { customHeaders: { host: "evil.test" } }, HTTP);
    return expect(p).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  });
});
