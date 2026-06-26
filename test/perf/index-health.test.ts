/**
 * Index-health check (06-testing section 7). Deterministic guard that the dispatch hot-path queries
 * are served by their partial indexes rather than degrading to sequential scans. Throughput/latency
 * measurements live in throughput.test.ts; this asserts only the plan shape. Requires Docker.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { postgresStore } from "../../src/store/pg";
import { dockerAvailable, startPostgres, type PgConn } from "../integration/_helpers";

// The dispatcher's claim filter (02-store section 6): find pending rows that are due, oldest first.
const DUE_QUERY =
  "SELECT id FROM webhook_outbox WHERE status = 'pending' AND available_at <= now() ORDER BY available_at";
// The reclaim sweep filter (02-store section 6): in_flight rows whose lock has expired.
const RECLAIM_QUERY =
  "SELECT id FROM webhook_outbox WHERE status = 'in_flight' AND locked_at < now()";

describe.skipIf(!dockerAvailable())("index health (integration)", () => {
  let conn: PgConn;
  let stop: () => Promise<void>;
  let pool: Pool;

  beforeAll(async () => {
    const started = await startPostgres();
    conn = started.conn;
    stop = started.stop;
    pool = new Pool(conn);
    await postgresStore({ pool }).migrate();
    for (let i = 0; i < 50; i++) {
      await pool.query(
        "INSERT INTO webhook_outbox (id, event_type, payload, target_url, status) VALUES (gen_random_uuid(), 'e', '{}'::jsonb, 'https://x.test/hook', 'pending')",
      );
    }
    // A few in_flight rows so the reclaim partial index has live entries to plan against.
    for (let i = 0; i < 10; i++) {
      await pool.query(
        "INSERT INTO webhook_outbox (id, event_type, payload, target_url, status, locked_at, locked_by) VALUES (gen_random_uuid(), 'e', '{}'::jsonb, 'https://x.test/hook', 'in_flight', now() - interval '1 hour', 'w')",
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
});
