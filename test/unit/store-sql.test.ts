/**
 * Locks the shape of the combined-write CTE (completeAttempt). Placeholders must follow textual
 * order so the same binding order works for pg (`$n`) and knex.raw (positional `?`). This is the
 * Docker-free guard for the SQL the integration suite exercises against real Postgres.
 */
import { describe, expect, it } from "vitest";
import { completeAttemptSql } from "../../src/store/_shared";
import { postgres } from "../../src/store/sql/postgres";

describe("completeAttemptSql", () => {
  it("numbers placeholders in textual order: attempt values, SET values, then id (pg)", () => {
    const sql = completeAttemptSql(["status", "locked_at"], "numbered");
    // 8 attempt columns; request_headers (4th) is cast to jsonb.
    expect(sql).toContain("VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)");
    // SET values come next ($9, $10), the id placeholder ($11) is last.
    expect(sql).toContain("SET status = $9, locked_at = $10");
    expect(sql).toContain("WHERE id = $11 AND status = 'in_flight'");
  });

  it("emits positional ? in the same textual order for knex.raw", () => {
    const sql = completeAttemptSql(["status", "locked_at"], "qmark");
    expect(sql).toContain("?::jsonb");
    expect(sql).toContain("SET status = ?, locked_at = ?");
    expect(sql).toContain("WHERE id = ? AND status = 'in_flight'");
    // 8 attempt values + 2 SET values + 1 id = 11 placeholders.
    expect((sql.match(/\?/g) ?? []).length).toBe(11);
  });

  it("appends the locked_by guard as the final placeholder when guardLockedBy is set (pg)", () => {
    const sql = completeAttemptSql(["status"], "numbered", { guardLockedBy: true });
    // 8 attempt values + 1 SET value + id ($10) + locked_by ($11).
    expect(sql).toContain("WHERE id = $10 AND status = 'in_flight' AND locked_by = $11");
  });

  it("appends the locked_by guard as a trailing ? for knex.raw when guardLockedBy is set", () => {
    const sql = completeAttemptSql(["status"], "qmark", { guardLockedBy: true });
    expect(sql).toContain("AND status = 'in_flight' AND locked_by = ?");
    // 8 attempt + 1 SET + 1 id + 1 locked_by = 11 placeholders.
    expect((sql.match(/\?/g) ?? []).length).toBe(11);
  });
});

describe("per-endpoint FIFO claim SQL", () => {
  it("claims one head row per endpoint with a skip-locked lock (pg, $n reused for now)", () => {
    const sql = postgres.claimSqlPerEndpoint.numbered;
    expect(sql).toContain("DISTINCT ON (endpoint_id)");
    expect(sql).toContain("status IN ('pending', 'in_flight')");
    expect(sql).toContain("FOR UPDATE OF o SKIP LOCKED");
    // now ($1) appears in both filters and the SET; limit ($2) and lockedBy ($3) once each.
    expect(sql).toContain("head.available_at <= $1");
    expect(sql).toContain("LIMIT $2");
    expect(sql).toContain("locked_by = $3");
  });

  it("uses positional ? in textual order for knex.raw (now, now, limit, now, lockedBy)", () => {
    const sql = postgres.claimSqlPerEndpoint.qmark;
    // 2 now filters + 1 limit + 1 now(SET) + 1 lockedBy = 5 placeholders.
    expect((sql.match(/\?/g) ?? []).length).toBe(5);
    expect(sql).toContain("FOR UPDATE OF o SKIP LOCKED");
  });
});
