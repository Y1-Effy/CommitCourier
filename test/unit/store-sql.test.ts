/**
 * Locks the shape of the combined-write CTE (completeAttempt). Placeholders must follow textual
 * order so the same binding order works for pg (`$n`) and knex.raw (positional `?`). This is the
 * Docker-free guard for the SQL the integration suite exercises against real Postgres.
 */
import { describe, expect, it } from "vitest";
import { completeAttemptSql } from "../../src/store/_shared";

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
});
