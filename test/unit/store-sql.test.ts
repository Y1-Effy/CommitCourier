/**
 * Locks the shape of the combined-write CTE (completeAttempt). Placeholders must follow textual
 * order so the same binding order works for pg (`$n`) and knex.raw (positional `?`). This is the
 * Docker-free guard for the SQL the integration suite exercises against real Postgres.
 */
import { describe, expect, it } from "vitest";
import { completeAttemptSql, replayWhere, numberedToQmark } from "../../src/store/_shared";
import { postgres } from "../../src/store/sql/postgres";

describe("numberedToQmark (knex executor translation)", () => {
  it("maps each $n to a ? bound to params[n-1] in textual order", () => {
    const { sql, bindings } = numberedToQmark("UPDATE t SET a = $1, b = $2 WHERE id = $3", [
      "va",
      "vb",
      "id1",
    ]);
    expect(sql).toBe("UPDATE t SET a = ?, b = ? WHERE id = ?");
    expect(bindings).toEqual(["va", "vb", "id1"]);
  });

  it("rebinds a reused placeholder by textual occurrence (the claim CTE's $1)", () => {
    // The claim SQL reuses $1 (now) for both the filter and the SET; qmark must bind it twice.
    const { sql, bindings } = numberedToQmark(
      "WHERE available_at <= $1 LIMIT $2 ... SET locked_at = $1, locked_by = $3",
      ["NOW", "LIM", "WORKER"],
    );
    expect(sql).toBe("WHERE available_at <= ? LIMIT ? ... SET locked_at = ?, locked_by = ?");
    expect(bindings).toEqual(["NOW", "LIM", "NOW", "WORKER"]);
  });

  it("reorders bindings to textual order when numbered order differs (SET before WHERE)", () => {
    // applyTransition binds [id, ...values] but $1 (id) appears textually after the SET values.
    const { sql, bindings } = numberedToQmark(
      "UPDATE t SET status = $2, attempts = $3 WHERE id = $1",
      ["id1", "delivered", 5],
    );
    expect(sql).toBe("UPDATE t SET status = ?, attempts = ? WHERE id = ?");
    expect(bindings).toEqual(["delivered", 5, "id1"]);
  });

  it("preserves ::jsonb casts and handles multi-row inserts", () => {
    const { sql, bindings } = numberedToQmark(
      "INSERT INTO t (a, p) VALUES ($1, $2::jsonb), ($3, $4::jsonb)",
      ["a1", "{}", "a2", "[]"],
    );
    expect(sql).toBe("INSERT INTO t (a, p) VALUES (?, ?::jsonb), (?, ?::jsonb)");
    expect(bindings).toEqual(["a1", "{}", "a2", "[]"]);
  });

  it("is a no-op for parameterless SQL", () => {
    const { sql, bindings } = numberedToQmark("SELECT count(*) FROM t", []);
    expect(sql).toBe("SELECT count(*) FROM t");
    expect(bindings).toEqual([]);
  });
});

describe("completeAttemptSql", () => {
  it("numbers placeholders in textual order: attempt values, SET values, then id (pg)", () => {
    const sql = completeAttemptSql(["status", "locked_at"]);
    // 8 attempt columns; request_headers (4th) is cast to jsonb.
    expect(sql).toContain("VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)");
    // SET values come next ($9, $10), the id placeholder ($11) is last.
    expect(sql).toContain("SET status = $9, locked_at = $10");
    expect(sql).toContain("WHERE id = $11 AND status = 'in_flight'");
  });

  it("translates to positional ? in the same textual order for knex.raw", () => {
    // The knex adapter runs the numbered SQL through numberedToQmark — assert that real composition.
    const sql = numberedToQmark(completeAttemptSql(["status", "locked_at"]), new Array(11)).sql;
    expect(sql).toContain("?::jsonb");
    expect(sql).toContain("SET status = ?, locked_at = ?");
    expect(sql).toContain("WHERE id = ? AND status = 'in_flight'");
    // 8 attempt values + 2 SET values + 1 id = 11 placeholders.
    expect((sql.match(/\?/g) ?? []).length).toBe(11);
  });

  it("appends the locked_by guard as the final placeholder when guardLockedBy is set (pg)", () => {
    const sql = completeAttemptSql(["status"], { guardLockedBy: true });
    // 8 attempt values + 1 SET value + id ($10) + locked_by ($11).
    expect(sql).toContain("WHERE id = $10 AND status = 'in_flight' AND locked_by = $11");
  });

  it("appends the locked_by guard as a trailing ? for knex.raw when guardLockedBy is set", () => {
    const sql = numberedToQmark(
      completeAttemptSql(["status"], { guardLockedBy: true }),
      new Array(11),
    ).sql;
    expect(sql).toContain("AND status = 'in_flight' AND locked_by = ?");
    // 8 attempt + 1 SET + 1 id + 1 locked_by = 11 placeholders.
    expect((sql.match(/\?/g) ?? []).length).toBe(11);
  });
});

describe("replayWhere", () => {
  it("always excludes active rows so a live row is never copied into a duplicate", () => {
    const { sql, params } = replayWhere({});
    // The guard is present even with no filter, and is a literal (contributes no bind param).
    expect(sql).toBe("WHERE status NOT IN ('pending', 'in_flight')");
    expect(params).toEqual([]);
  });

  it("ANDs the active-row guard ahead of the optional filters (numbered binds)", () => {
    const since = new Date("2026-06-27T00:00:00.000Z");
    const { sql, params } = replayWhere({ outboxId: "id-1", status: "dead", since });
    expect(sql).toBe(
      "WHERE status NOT IN ('pending', 'in_flight') AND id = $1 AND status = $2 AND created_at >= $3",
    );
    expect(params).toEqual(["id-1", "dead", since]);
  });
});

describe("per-endpoint FIFO claim SQL", () => {
  it("claims one head row per endpoint with a skip-locked lock (pg, $n reused for now)", () => {
    const sql = postgres.claimSqlPerEndpoint;
    expect(sql).toContain("DISTINCT ON (endpoint_id)");
    expect(sql).toContain("status IN ('pending', 'in_flight')");
    expect(sql).toContain("FOR UPDATE OF o SKIP LOCKED");
    // now ($1) appears in both filters and the SET; limit ($2) and lockedBy ($3) once each.
    expect(sql).toContain("head.available_at <= $1");
    expect(sql).toContain("LIMIT $2");
    expect(sql).toContain("locked_by = $3");
  });

  it("translates to positional ? in textual order for knex.raw (now, now, limit, now, lockedBy)", () => {
    // The knex adapter binds [now, limit, lockedBy] and lets numberedToQmark re-bind the reused $1.
    const { sql, bindings } = numberedToQmark(postgres.claimSqlPerEndpoint, [
      "NOW",
      "LIM",
      "WORKER",
    ]);
    // 2 now filters + 1 limit + 1 now(SET) + 1 lockedBy = 5 placeholders.
    expect((sql.match(/\?/g) ?? []).length).toBe(5);
    expect(bindings).toEqual(["NOW", "NOW", "LIM", "NOW", "WORKER"]);
    expect(sql).toContain("FOR UPDATE OF o SKIP LOCKED");
  });
});
