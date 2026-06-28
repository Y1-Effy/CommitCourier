/**
 * Claim-throughput benchmark (per the performance plan). Seeds a large table of already-delivered
 * rows plus a live pending backlog, then drains the backlog via `claimDue` and reports rows/sec.
 *
 * The point is to show the partial `ix_outbox_due` keeps claims fast even when the table is mostly
 * delivered rows: the index only holds the live backlog, so claim cost tracks the backlog, not the
 * table. Measured numbers are logged (compare by toggling the index locally); the assertions stay
 * loose — full drain (deterministic) plus a generous floor — so the test is a regression guard, not
 * a flaky perf gate. Requires Docker.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { postgresStore } from "../../src/store/pg";
import type { Store } from "../../src/store/store";
import { dockerAvailable, newPgPool, startPostgres, type PgConn } from "../integration/_helpers";

const DELIVERED_ROWS = 10_000; // background bulk the hot index must NOT have to wade through
const PENDING_ROWS = 2_000; // the live backlog to drain
const CLAIM_BATCH = 200;
// Conservative floor: even a cold local container drains far faster than this; well below it means
// the claim path regressed (e.g. the partial index was lost and claims went sequential).
const MIN_ROWS_PER_SEC = 200;

describe.skipIf(!dockerAvailable())("claim throughput (integration)", () => {
  let conn: PgConn;
  let stop: () => Promise<void>;
  let pool: Pool;
  let store: Store;

  beforeAll(async () => {
    const started = await startPostgres();
    conn = started.conn;
    stop = started.stop;
    pool = newPgPool(conn);
    store = postgresStore({ pool });
    await store.migrate();
    // Bulk-seed with a single set-returning insert per batch so setup stays well under the perf
    // timeout. IDs come from a JS-generated array unnested into the SELECT (like the rest of the
    // suite) rather than SQL gen_random_uuid(), which is only built in on PostgreSQL 13+; this keeps
    // the seeding portable down to PG 12 without losing the single-round-trip bulk insert.
    const deliveredIds = Array.from({ length: DELIVERED_ROWS }, () => randomUUID());
    const pendingIds = Array.from({ length: PENDING_ROWS }, () => randomUUID());
    await pool.query(
      `INSERT INTO webhook_outbox (id, event_type, payload, target_url, status, available_at)
       SELECT u, 'e', '{}'::jsonb, 'https://x.test/hook', 'delivered', now()
       FROM unnest($1::uuid[]) AS u`,
      [deliveredIds],
    );
    await pool.query(
      `INSERT INTO webhook_outbox (id, event_type, payload, target_url, status, available_at)
       SELECT u, 'e', '{}'::jsonb, 'https://x.test/hook', 'pending', now() - interval '1 minute'
       FROM unnest($1::uuid[]) AS u`,
      [pendingIds],
    );
    await pool.query("ANALYZE webhook_outbox");
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await stop();
  });

  it("drains the pending backlog and reports claim throughput", async () => {
    const lockedBy = "bench";
    let drained = 0;
    const start = Date.now();
    for (;;) {
      // Each claim moves up to CLAIM_BATCH pending rows to in_flight, so the loop drains the backlog
      // in PENDING_ROWS / CLAIM_BATCH round trips, exercising the partial index every time.
      const rows = await store.claimDue({ limit: CLAIM_BATCH, lockedBy, now: new Date() });
      if (rows.length === 0) break;
      drained += rows.length;
    }
    const elapsedMs = Date.now() - start;
    const rowsPerSec = Math.round((drained / elapsedMs) * 1000);
    console.log(
      `[bench] drained ${String(drained)} pending rows from a ${String(
        DELIVERED_ROWS + PENDING_ROWS,
      )}-row table in ${elapsedMs.toFixed(0)}ms = ${String(rowsPerSec)} rows/sec`,
    );

    expect(drained).toBe(PENDING_ROWS); // deterministic: the whole backlog was claimed
    expect(rowsPerSec).toBeGreaterThan(MIN_ROWS_PER_SEC); // loose regression floor
  });
});
