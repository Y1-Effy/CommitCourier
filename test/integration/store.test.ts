/**
 * Store integration suite (06-testing section 4). The same assertions run against both the pg
 * and knex adapters to prove identical semantics. Requires Docker (testcontainers); skips
 * cleanly when none is available.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { onSuccess } from "../../src/core/index";
import {
  dockerAvailable,
  knexHarness,
  pgHarness,
  sampleRow,
  startPostgres,
  truncateAll,
  type Harness,
  type PgConn,
} from "./_helpers";

const HARNESS_NAMES = ["pg", "knex"] as const;

const findById = (
  rows: Record<string, unknown>[],
  id: string,
): Record<string, unknown> | undefined => rows.find((r) => r.id === id);

describe.skipIf(!dockerAvailable())("store adapters (integration)", () => {
  let stop: () => Promise<void>;
  let conn: PgConn;
  const harnesses: Record<string, Harness> = {};

  beforeAll(async () => {
    const started = await startPostgres();
    conn = started.conn;
    stop = started.stop;
    harnesses.pg = pgHarness(conn);
    harnesses.knex = knexHarness(conn);
    // Migrate once via one adapter; both share the same schema.
    await harnesses.pg.store.migrate();
  });

  afterAll(async () => {
    for (const name of HARNESS_NAMES) await harnesses[name]?.teardown();
    await stop();
  });

  describe.each(HARNESS_NAMES)("%s adapter", (name) => {
    const h = (): Harness => harnesses[name]!;

    beforeEach(async () => {
      await truncateAll(h());
    });

    it("migrate is idempotent and diagnose reports ok", async () => {
      await h().store.migrate(); // second run must not throw
      const d = await h().store.diagnose();
      expect(d.ok).toBe(true);
      expect(d.missingTables).toEqual([]);
    });

    it("insertOutbox rides the user TX: commit persists, rollback discards", async () => {
      const committed = sampleRow();
      await h().enqueue(committed);
      const rolledBack = sampleRow();
      await h().enqueue(rolledBack, { rollback: true });

      const rows = await h().raw("SELECT * FROM webhook_outbox");
      expect(findById(rows, committed.id)).toBeDefined();
      expect(findById(rows, rolledBack.id)).toBeUndefined();
    });

    it("claimDue moves pending -> in_flight and is not reclaimed twice", async () => {
      const row = sampleRow();
      await h().enqueue(row);

      const claimed = await h().store.claimDue({ limit: 10, lockedBy: "w1", now: new Date() });
      expect(claimed.map((r) => r.id)).toContain(row.id);
      expect(claimed.find((r) => r.id === row.id)?.status).toBe("in_flight");

      const again = await h().store.claimDue({ limit: 10, lockedBy: "w2", now: new Date() });
      expect(again.map((r) => r.id)).not.toContain(row.id);
    });

    it("claimDue with SKIP LOCKED never double-claims under concurrency", async () => {
      const ids = new Set<string>();
      for (let i = 0; i < 20; i++) {
        const row = sampleRow();
        ids.add(row.id);
        await h().enqueue(row);
      }
      const workers = Array.from({ length: 4 }, (_, i) =>
        h().store.claimDue({ limit: 10, lockedBy: `w${String(i)}`, now: new Date() }),
      );
      const results = await Promise.all(workers);
      const claimed = results.flat().map((r) => r.id);

      expect(new Set(claimed).size).toBe(claimed.length); // no duplicates
      expect(new Set(claimed)).toEqual(ids); // every row claimed exactly once
    });

    it("reclaimStuck recovers only stale in_flight rows", async () => {
      const stale = sampleRow();
      const fresh = sampleRow();
      await h().enqueue(stale);
      await h().enqueue(fresh);
      await h().raw(
        `UPDATE webhook_outbox SET status='in_flight', locked_at = now() - interval '1 hour' WHERE id = '${stale.id}'`,
      );
      await h().raw(
        `UPDATE webhook_outbox SET status='in_flight', locked_at = now() WHERE id = '${fresh.id}'`,
      );

      const count = await h().store.reclaimStuck({ reclaimAfterMs: 5 * 60_000, now: new Date() });
      expect(count).toBe(1);

      const rows = await h().raw("SELECT * FROM webhook_outbox");
      expect(findById(rows, stale.id)?.status).toBe("pending");
      expect(findById(rows, fresh.id)?.status).toBe("in_flight");
    });

    it("applyTransition only affects rows still in_flight", async () => {
      const row = sampleRow();
      await h().enqueue(row);

      // Guard blocks transitions on a pending row.
      await h().store.applyTransition(row.id, onSuccess(new Date()));
      let rows = await h().raw("SELECT * FROM webhook_outbox");
      expect(findById(rows, row.id)?.status).toBe("pending");

      // After claiming, the same transition succeeds.
      await h().store.claimDue({ limit: 10, lockedBy: "w1", now: new Date() });
      await h().store.applyTransition(row.id, onSuccess(new Date()));
      rows = await h().raw("SELECT * FROM webhook_outbox");
      expect(findById(rows, row.id)?.status).toBe("delivered");
    });

    it("recordAttempt appends to the ledger and queryAttempts reads it back", async () => {
      const row = sampleRow();
      await h().enqueue(row);
      await h().store.recordAttempt({
        outboxId: row.id,
        attemptNo: 1,
        requestHeaders: { "webhook-id": row.id },
        responseStatus: 200,
        responseBodySnippet: "ok",
        durationMs: 42,
        error: null,
      });

      const attempts = await h().store.queryAttempts({ outboxId: row.id });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.attemptNo).toBe(1);
      expect(attempts[0]?.responseStatus).toBe(200);
      expect(attempts[0]?.requestHeaders["webhook-id"]).toBe(row.id);
    });

    it("selectForReplay + insertReplayCopies create fresh pending rows inheriting the key", async () => {
      const dead = sampleRow({ status: "dead", idempotencyKey: "idem-1" });
      await h().enqueue(dead);

      const selected = await h().store.selectForReplay({ status: "dead" });
      expect(selected.map((r) => r.id)).toContain(dead.id);

      const copies = selected.map((r) =>
        sampleRow({ idempotencyKey: r.idempotencyKey, payload: r.payload }),
      );
      const newIds = await h().store.insertReplayCopies(copies);
      expect(newIds).toHaveLength(1);

      const rows = await h().raw("SELECT * FROM webhook_outbox");
      const copy = findById(rows, newIds[0]!);
      expect(copy?.status).toBe("pending");
      expect(copy?.idempotency_key).toBe("idem-1");
    });

    it("findEndpoint and disableEndpoint manage registered endpoints", async () => {
      const epId = sampleRow().id; // reuse a uuid generator
      await h().raw(
        `INSERT INTO webhook_endpoints (id, url, secret) VALUES ('${epId}', 'https://example.test/hook', 'whsec_x')`,
      );

      const found = await h().store.findEndpoint(epId);
      expect(found?.status).toBe("active");

      await h().store.disableEndpoint(epId, new Date());
      const after = await h().store.findEndpoint(epId);
      expect(after?.status).toBe("disabled");
      expect(after?.disabledAt).toBeInstanceOf(Date);

      expect(await h().store.findEndpoint(sampleRow().id)).toBeNull();
    });
  });
});
