/**
 * Docker-free guard for the read-only list/DLQ query builders (v1.2). Locks the secret-free column
 * sets, keyset ordering, numbered (`$n`) filter/cursor placeholders (knex translates them to `?` via
 * numberedToQmark), the page-size clamp, and the `nextCursor` derivation the four relational adapters
 * share via these helpers.
 */
import { describe, expect, it } from "vitest";
import {
  OUTBOX_LIST_COLUMNS,
  ENDPOINT_LIST_COLUMNS,
  buildOutboxListQuery,
  buildEndpointListQuery,
  outboxListPage,
  endpointListPage,
  clampListLimit,
  LIST_DEFAULT_LIMIT,
  LIST_MAX_LIMIT,
  numberedToQmark,
} from "../../src/store/_shared";

describe("list column sets are secret-free", () => {
  it("never selects the outbox secret snapshot, but includes seq for the cursor", () => {
    expect(OUTBOX_LIST_COLUMNS).not.toContain("secret_snapshot");
    expect(OUTBOX_LIST_COLUMNS).toContain("seq");
    expect(OUTBOX_LIST_COLUMNS).toContain("last_error");
  });

  it("never selects endpoint secrets", () => {
    expect(ENDPOINT_LIST_COLUMNS).not.toContain("secret");
    expect(ENDPOINT_LIST_COLUMNS).not.toContain("secret_secondary");
    expect(ENDPOINT_LIST_COLUMNS).toContain("url");
    expect(ENDPOINT_LIST_COLUMNS).toContain("status");
  });

  it("never selects custom_headers, which the list surface could not decrypt", () => {
    // The list path deliberately skips the encrypted-store decorator's decryption (that is what makes
    // it safe to pass through). Selecting this secret-bearing column here would hand back ciphertext.
    expect(ENDPOINT_LIST_COLUMNS).not.toContain("custom_headers");
  });
});

describe("buildOutboxListQuery", () => {
  it("orders newest-first by seq and clamps the limit when no filter is given (pg)", () => {
    const { sql, params } = buildOutboxListQuery({});
    expect(sql).toContain("ORDER BY seq DESC");
    expect(sql).not.toContain("WHERE");
    // Only the LIMIT binding is present, defaulted.
    expect(params).toEqual([LIST_DEFAULT_LIMIT]);
    expect(sql).toContain("LIMIT $1");
  });

  it("emits status/since/endpointId filters and a bigint-cast cursor in textual order (pg)", () => {
    const since = new Date(0);
    const { sql, params } = buildOutboxListQuery({
      status: "dead",
      since,
      endpointId: "ep-1",
      cursor: "42",
      limit: 10,
    });
    expect(sql).toContain("status = $1");
    expect(sql).toContain("created_at >= $2");
    expect(sql).toContain("endpoint_id = $3");
    // The cursor is cast to bigint so a text param compares against the bigint seq column.
    expect(sql).toContain("seq < ($4)::bigint");
    expect(sql).toContain("LIMIT $5");
    expect(params).toEqual(["dead", since, "ep-1", "42", 10]);
  });

  it("translates to positional ? in the same textual order for knex.raw", () => {
    // The knex adapter runs the numbered SQL + params through numberedToQmark.
    const built = buildOutboxListQuery({ status: "dead", cursor: "7" });
    const { sql, bindings } = numberedToQmark(built.sql, built.params);
    expect(sql).toContain("status = ?");
    expect(sql).toContain("seq < (?)::bigint");
    expect(sql).toContain("LIMIT ?");
    expect(bindings).toEqual(["dead", "7", LIST_DEFAULT_LIMIT]);
  });
});

describe("buildEndpointListQuery", () => {
  it("orders by id ascending, with an id-keyset cursor and status filter (pg)", () => {
    const { sql, params } = buildEndpointListQuery({ status: "active", cursor: "id-1", limit: 5 });
    expect(sql).toContain("ORDER BY id ASC");
    expect(sql).toContain("status = $1");
    expect(sql).toContain("id > $2");
    expect(sql).toContain("LIMIT $3");
    expect(params).toEqual(["active", "id-1", 5]);
  });
});

describe("clampListLimit", () => {
  it("defaults when absent/invalid and caps at the ceiling", () => {
    expect(clampListLimit(undefined)).toBe(LIST_DEFAULT_LIMIT);
    expect(clampListLimit(0)).toBe(LIST_DEFAULT_LIMIT);
    expect(clampListLimit(-3)).toBe(LIST_DEFAULT_LIMIT);
    expect(clampListLimit(Number.NaN)).toBe(LIST_DEFAULT_LIMIT);
    expect(clampListLimit(10)).toBe(10);
    expect(clampListLimit(LIST_MAX_LIMIT + 1000)).toBe(LIST_MAX_LIMIT);
  });
});

describe("page folding derives nextCursor only when the page is full", () => {
  const rawOutbox = (id: string, seq: bigint) => ({
    id,
    event_type: "e",
    payload: {},
    endpoint_id: null,
    target_url: "https://x.test/h",
    status: "dead",
    attempts: 3,
    available_at: new Date(0),
    locked_at: null,
    locked_by: null,
    idempotency_key: null,
    last_error: "boom",
    created_at: new Date(0),
    dispatched_at: null,
    seq,
  });

  it("normalises a BigInt seq to a decimal-string cursor and pages when full", () => {
    const page = outboxListPage([rawOutbox("a", 9n), rawOutbox("b", 8n)], 2);
    expect(page.items[0]?.seq).toBe("9");
    expect(page.items[1]?.seq).toBe("8");
    expect(page.nextCursor).toBe("8");
    expect(page.items[0]).not.toHaveProperty("secretSnapshot");
  });

  it("returns nextCursor=null on a partial (last) page", () => {
    const page = outboxListPage([rawOutbox("a", 9n)], 2);
    expect(page.nextCursor).toBeNull();
  });

  it("derives the endpoint cursor from the last id when full", () => {
    const ep = (id: string) => ({
      id,
      url: "https://x.test/h",
      status: "active",
      description: null,
      consecutive_failures: 0,
      disabled_at: null,
      metadata: null,
      created_at: new Date(0),
    });
    const page = endpointListPage([ep("id-1"), ep("id-2")], 2);
    expect(page.nextCursor).toBe("id-2");
    expect(page.items[0]).not.toHaveProperty("secret");
  });
});
