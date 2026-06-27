/**
 * Docker-free guards for the v2.1 operability SQL/helpers (cancel, circuit breaker, get-by-id,
 * replay cap). Placeholders must follow textual order so the same binding order works for pg (`$n`)
 * and knex.raw (positional `?`); the integration suite exercises these against real Postgres.
 */
import { describe, expect, it } from "vitest";
import {
  CANCEL_PENDING_SQL,
  NOTE_ENDPOINT_SUCCESS_SQL,
  GET_OUTBOX_SQL,
  buildNoteEndpointFailureSql,
  noteEndpointFailureParams,
  clampReplayLimit,
  REPLAY_DEFAULT_LIMIT,
  REPLAY_MAX_LIMIT,
  buildPruneSql,
  pruneParams,
  clampPruneLimit,
  PRUNE_DEFAULT_LIMIT,
  PRUNE_MAX_LIMIT,
} from "../../src/store/_shared";

describe("cancel SQL", () => {
  it("guards the UPDATE on pending so a claimed/terminal row is never cancelled", () => {
    expect(CANCEL_PENDING_SQL).toContain("SET status = 'cancelled'");
    expect(CANCEL_PENDING_SQL).toContain("WHERE id = $1 AND status = 'pending'");
    // It clears the lock so a cancelled row carries no stale lock fields.
    expect(CANCEL_PENDING_SQL).toContain("locked_at = NULL");
    expect(CANCEL_PENDING_SQL).toContain("locked_by = NULL");
  });
});

describe("circuit-breaker SQL", () => {
  it("resets the counter only when it is non-zero (no hot-path write when healthy)", () => {
    expect(NOTE_ENDPOINT_SUCCESS_SQL).toContain("consecutive_failures = 0");
    expect(NOTE_ENDPOINT_SUCCESS_SQL).toContain("WHERE id = $1 AND consecutive_failures <> 0");
  });

  it("increments and auto-disables atomically; numbered reuses $2 for the threshold (pg)", () => {
    const sql = buildNoteEndpointFailureSql("numbered");
    expect(sql).toContain("consecutive_failures = consecutive_failures + 1");
    // The threshold is $2 (reused in both CASE arms), now is $3, id is $1.
    expect(sql).toContain("consecutive_failures + 1 >= $2 AND status = 'active' THEN 'disabled'");
    expect(sql).toContain("THEN $3 ELSE disabled_at END");
    expect(sql).toContain("WHERE id = $1");
    expect(noteEndpointFailureParams("numbered", "ep-1", new Date(0), 5)).toEqual([
      "ep-1",
      5,
      new Date(0),
    ]);
  });

  it("lists the threshold twice for knex.raw (positional ? cannot be reused)", () => {
    const sql = buildNoteEndpointFailureSql("qmark");
    expect((sql.match(/\?/g) ?? []).length).toBe(4); // thr, thr, now, id
    // qmark binds in textual order: threshold, threshold, now, id.
    expect(noteEndpointFailureParams("qmark", "ep-1", new Date(0), 5)).toEqual([
      5,
      5,
      new Date(0),
      "ep-1",
    ]);
  });
});

describe("getOutbox SQL is secret-free", () => {
  it("selects by id and never selects the secret snapshot", () => {
    expect(GET_OUTBOX_SQL).toContain("WHERE id = $1");
    expect(GET_OUTBOX_SQL).not.toContain("secret_snapshot");
    // It includes the keyset/seq column so the single row matches the list-item shape.
    expect(GET_OUTBOX_SQL).toContain("seq");
  });
});

describe("prune SQL", () => {
  it("deletes via a bounded oldest-first inner SELECT; statuses expanded as IN placeholders (pg)", () => {
    const sql = buildPruneSql(3, "numbered");
    // The status set is expanded into individual placeholders (no bound array), then olderThan, then limit.
    expect(sql).toContain("status IN ($1, $2, $3)");
    expect(sql).toContain("created_at < $4");
    expect(sql).toContain("ORDER BY created_at LIMIT $5");
    // Outer DELETE over the bounded id set (so one call cannot delete an unbounded set).
    expect(sql).toMatch(/^DELETE FROM webhook_outbox WHERE id IN \(SELECT id FROM webhook_outbox/);
  });

  it("emits positional ? in textual order for knex.raw", () => {
    const sql = buildPruneSql(2, "qmark");
    expect(sql).toContain("status IN (?, ?)");
    // 2 statuses + olderThan + limit = 4 placeholders.
    expect((sql.match(/\?/g) ?? []).length).toBe(4);
  });

  it("binds the statuses, then olderThan, then limit", () => {
    const t = new Date("2026-01-01T00:00:00.000Z");
    expect(pruneParams(["delivered", "dead"], t, 100)).toEqual(["delivered", "dead", t, 100]);
  });
});

describe("clampPruneLimit", () => {
  it("defaults when absent/invalid and caps at the hard ceiling", () => {
    expect(clampPruneLimit(undefined)).toBe(PRUNE_DEFAULT_LIMIT);
    expect(clampPruneLimit(0)).toBe(PRUNE_DEFAULT_LIMIT);
    expect(clampPruneLimit(-1)).toBe(PRUNE_DEFAULT_LIMIT);
    expect(clampPruneLimit(PRUNE_MAX_LIMIT + 1)).toBe(PRUNE_MAX_LIMIT);
    expect(clampPruneLimit(500)).toBe(500);
  });
});

describe("clampReplayLimit", () => {
  it("defaults when absent/invalid and caps at the hard ceiling", () => {
    expect(clampReplayLimit(undefined)).toBe(REPLAY_DEFAULT_LIMIT);
    expect(clampReplayLimit(0)).toBe(REPLAY_DEFAULT_LIMIT);
    expect(clampReplayLimit(-5)).toBe(REPLAY_DEFAULT_LIMIT);
    expect(clampReplayLimit(Number.NaN)).toBe(REPLAY_DEFAULT_LIMIT);
    expect(clampReplayLimit(REPLAY_MAX_LIMIT + 1)).toBe(REPLAY_MAX_LIMIT);
    expect(clampReplayLimit(42)).toBe(42);
    expect(clampReplayLimit(42.9)).toBe(42); // floored
  });
});
