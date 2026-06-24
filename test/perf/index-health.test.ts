/**
 * Index-health check (06-testing section 7). Deterministic guard that the due-row query can be
 * served by ix_outbox_due rather than degrading to a sequential scan. Throughput/latency
 * measurements are intentionally omitted (flaky); this asserts only the plan shape. Requires Docker.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { postgresStore } from "../../src/store/pg";
import { dockerAvailable, startPostgres, type PgConn } from "../integration/_helpers";

// The dispatcher's claim filter (02-store section 6): find pending rows that are due, oldest first.
const DUE_QUERY =
  "SELECT id FROM webhook_outbox WHERE status = 'pending' AND available_at <= now() ORDER BY available_at";

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
    await pool.query("ANALYZE webhook_outbox");
  });

  afterAll(async () => {
    await pool.end();
    await stop();
  });

  it("serves the due-row query from ix_outbox_due, not a sequential scan", async () => {
    const client: PoolClient = await pool.connect();
    try {
      // With seq scans disabled the planner must use an applicable index; if ix_outbox_due covers
      // the query shape it appears in the plan, proving the due search does not need a seq scan.
      await client.query("SET enable_seqscan = off");
      const res = await client.query(`EXPLAIN ${DUE_QUERY}`);
      const plan = (res.rows as { "QUERY PLAN": string }[]).map((r) => r["QUERY PLAN"]).join("\n");
      expect(plan).toContain("ix_outbox_due");
    } finally {
      client.release();
    }
  });
});
