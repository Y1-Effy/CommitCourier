/**
 * Admin list-filter validation (v1.2 hardening): a malformed `status`/`endpointId`/`cursor` fails
 * fast as an `INVALID_ARGUMENT` RelayError before reaching the store, so callers get a clean error
 * instead of a raw Postgres cast error (`endpoint_id = $n` / `seq < ($n)::bigint` / `id > uuid`).
 * The functions are async, so the error is delivered as a Promise rejection (awaitable AND
 * `.then().catch()`-able), never thrown synchronously. No Docker.
 */
import { describe, expect, it } from "vitest";
import { listOutbox, listEndpoints } from "../../src/admin/admin";
import { RelayError } from "../../src/core/errors";
import type { Store } from "../../src/store/store";

function stubStore(): { store: Store; calls: { outbox: number; endpoints: number } } {
  const calls = { outbox: 0, endpoints: 0 };
  const store = {
    listOutbox: () => {
      calls.outbox++;
      return Promise.resolve({ items: [], nextCursor: null });
    },
    listEndpoints: () => {
      calls.endpoints++;
      return Promise.resolve({ items: [], nextCursor: null });
    },
  } as unknown as Store;
  return { store, calls };
}

const UUID = "11111111-1111-1111-1111-111111111111";

describe("listOutbox filter validation", () => {
  it("rejects (not throws) a non-numeric cursor with INVALID_ARGUMENT and never calls the store", async () => {
    const { store, calls } = stubStore();
    // Must not throw synchronously: the call returns a promise that rejects.
    const promise = listOutbox(store, { cursor: "abc" });
    await expect(promise).rejects.toBeInstanceOf(RelayError);
    await expect(promise).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(calls.outbox).toBe(0);
  });

  it("is .then().catch()-compatible (rejection, not a synchronous throw)", async () => {
    const { store } = stubStore();
    const caught = await listOutbox(store, { cursor: "abc" })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(RelayError);
  });

  it("rejects an unknown status", async () => {
    const { store } = stubStore();
    await expect(listOutbox(store, { status: "bogus" as never })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });

  it("rejects a non-uuid endpointId", async () => {
    const { store, calls } = stubStore();
    await expect(listOutbox(store, { endpointId: "garbage" })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(calls.outbox).toBe(0);
  });

  it("rejects a cursor beyond the int64 range", async () => {
    const { store } = stubStore();
    await expect(listOutbox(store, { cursor: "99999999999999999999" })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });

  it("accepts a numeric cursor, a uuid endpointId, and a known status; calls the store", async () => {
    const { store, calls } = stubStore();
    await listOutbox(store, { status: "dead", endpointId: UUID, cursor: "42", limit: 10 });
    // The exact int64 max is valid.
    await listOutbox(store, { cursor: "9223372036854775807" });
    expect(calls.outbox).toBe(2);
  });
});

describe("listEndpoints filter validation", () => {
  it("rejects a non-uuid cursor with INVALID_ARGUMENT", async () => {
    const { store, calls } = stubStore();
    await expect(listEndpoints(store, { cursor: "not-a-uuid" })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(calls.endpoints).toBe(0);
  });

  it("rejects an unknown status", async () => {
    const { store } = stubStore();
    await expect(listEndpoints(store, { status: "paused" as never })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
  });

  it("accepts a uuid cursor + known status and calls the store", async () => {
    const { store, calls } = stubStore();
    await listEndpoints(store, { status: "active", cursor: UUID });
    expect(calls.endpoints).toBe(1);
  });
});
