/**
 * Index-health check (06-testing section 7). Deterministic guard that the dispatch hot-path queries
 * are served by their partial indexes rather than degrading to sequential scans. Throughput/latency
 * measurements live in throughput.test.ts; this asserts only the plan shape. Requires Docker.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { postgresStore } from "../../src/store/pg";
import { dockerAvailable, newPgPool, startPostgres, type PgConn } from "../integration/_helpers";

// The dispatcher's claim filter (02-store section 6): find pending rows that are due, oldest first.
const DUE_QUERY =
  "SELECT id FROM webhook_outbox WHERE status = 'pending' AND available_at <= now() ORDER BY available_at";
// The reclaim sweep filter (02-store section 6): in_flight rows whose lock has expired.
const RECLAIM_QUERY =
  "SELECT id FROM webhook_outbox WHERE status = 'in_flight' AND locked_at < now()";
// The admin DLQ list (listOutbox): status-filtered, newest-first on the seq keyset.
const DLQ_LIST_QUERY =
  "SELECT id FROM webhook_outbox WHERE status = 'dead' ORDER BY seq DESC LIMIT 50";
// The retention prune inner select: oldest terminal rows, created_at-ordered, bounded LIMIT.
const PRUNE_INNER_QUERY =
  "SELECT id FROM webhook_outbox WHERE status IN ('delivered', 'dead', 'cancelled') AND created_at < now() ORDER BY created_at LIMIT 100";

describe.skipIf(!dockerAvailable())("index health (integration)", () => {
  let conn: PgConn;
  let stop: () => Promise<void>;
  let pool: Pool;

  beforeAll(async () => {
    const started = await startPostgres();
    conn = started.conn;
    stop = started.stop;
    pool = newPgPool(conn);
    await postgresStore({ pool }).migrate();
    // IDs are generated in JS (like the rest of the suite) rather than via SQL gen_random_uuid(),
    // which is only built in on PostgreSQL 13+; this keeps the seeding portable down to PG 12.
    for (let i = 0; i < 50; i++) {
      await pool.query(
        "INSERT INTO webhook_outbox (id, event_type, payload, target_url, status) VALUES ($1, 'e', '{}'::jsonb, 'https://x.test/hook', 'pending')",
        [randomUUID()],
      );
    }
    // A few in_flight rows so the reclaim partial index has live entries to plan against.
    for (let i = 0; i < 10; i++) {
      await pool.query(
        "INSERT INTO webhook_outbox (id, event_type, payload, target_url, status, locked_at, locked_by) VALUES ($1, 'e', '{}'::jsonb, 'https://x.test/hook', 'in_flight', now() - interval '1 hour', 'w')",
        [randomUUID()],
      );
    }
    // Terminal rows (dead/delivered) with staggered created_at so the admin-path partial indexes
    // (ix_outbox_terminal_seq, ix_outbox_prune from migration 003) have live entries to plan against.
    for (let i = 0; i < 40; i++) {
      const status = i % 2 === 0 ? "dead" : "delivered";
      await pool.query(
        "INSERT INTO webhook_outbox (id, event_type, payload, target_url, status, created_at) VALUES ($1, 'e', '{}'::jsonb, 'https://x.test/hook', $2, now() - ($3 || ' minutes')::interval)",
        [randomUUID(), status, String(i)],
      );
    }
    await pool.query("ANALYZE webhook_outbox");
  });

  afterAll(async () => {
    await pool.end();
    await stop();
  });

  async function explain(query: string): Promise<string> {
    const client: PoolClient = await pool.connect();
    try {
      // With seq scans disabled the planner must use an applicable index; the index name then
      // appears in the plan, proving the query shape does not degrade to a sequential scan.
      await client.query("SET enable_seqscan = off");
      const res = await client.query(`EXPLAIN ${query}`);
      return (res.rows as { "QUERY PLAN": string }[]).map((r) => r["QUERY PLAN"]).join("\n");
    } finally {
      client.release();
    }
  }

  it("serves the due-row claim query from the partial ix_outbox_due, not a sequential scan", async () => {
    expect(await explain(DUE_QUERY)).toContain("ix_outbox_due");
  });

  it("serves the reclaim sweep from the partial ix_outbox_inflight, not a sequential scan", async () => {
    expect(await explain(RECLAIM_QUERY)).toContain("ix_outbox_inflight");
  });

  it("serves the DLQ list (status + seq keyset) from the partial ix_outbox_terminal_seq", async () => {
    expect(await explain(DLQ_LIST_QUERY)).toContain("ix_outbox_terminal_seq");
  });

  it("serves the prune oldest-first select from the partial ix_outbox_prune", async () => {
    expect(await explain(PRUNE_INNER_QUERY)).toContain("ix_outbox_prune");
  });
});
