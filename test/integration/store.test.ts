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
  type Harness,
  type PgConn,
} from "./_helpers";

const HARNESS_NAMES = ["pg", "knex"] as const;

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
      await h().reset();
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

      expect(await h().getOutbox(committed.id)).toBeDefined();
      expect(await h().getOutbox(rolledBack.id)).toBeUndefined();
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
      const now = new Date();
      await h().setInFlight(stale.id, new Date(now.getTime() - 60 * 60_000)); // 1h ago
      await h().setInFlight(fresh.id, now);

      const count = await h().store.reclaimStuck({ reclaimAfterMs: 5 * 60_000, now });
      expect(count).toBe(1);

      expect((await h().getOutbox(stale.id))?.status).toBe("pending");
      expect((await h().getOutbox(fresh.id))?.status).toBe("in_flight");
    });

    it("applyTransition only affects rows still in_flight", async () => {
      const row = sampleRow();
      await h().enqueue(row);

      // Guard blocks transitions on a pending row.
      await h().store.applyTransition(row.id, onSuccess(new Date()));
      expect((await h().getOutbox(row.id))?.status).toBe("pending");

      // After claiming, the same transition succeeds.
      await h().store.claimDue({ limit: 10, lockedBy: "w1", now: new Date() });
      await h().store.applyTransition(row.id, onSuccess(new Date()));
      expect((await h().getOutbox(row.id))?.status).toBe("delivered");
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

      const copy = await h().getOutbox(newIds[0]!);
      expect(copy?.status).toBe("pending");
      expect(copy?.idempotencyKey).toBe("idem-1");
    });

    it("findEndpoint and disableEndpoint manage registered endpoints", async () => {
      const epId = sampleRow().id; // reuse a uuid generator
      await h().insertEndpoint({ id: epId, url: "https://example.test/hook", secret: "whsec_x" });

      const found = await h().store.findEndpoint(epId);
      expect(found?.status).toBe("active");

      await h().store.disableEndpoint(epId, new Date());
      const after = await h().store.findEndpoint(epId);
      expect(after?.status).toBe("disabled");
      expect(after?.disabledAt).toBeInstanceOf(Date);

      expect(await h().store.findEndpoint(sampleRow().id)).toBeNull();
    });

    it("insertEndpoint + updateEndpoint manage registered endpoints (no raw SQL)", async () => {
      const id = sampleRow().id;
      await h().store.insertEndpoint({
        id,
        url: "https://a.test/hook",
        secret: "whsec_a",
        description: "first",
        metadata: { team: "payments" },
      });

      const created = await h().store.findEndpoint(id);
      expect(created?.status).toBe("active");
      expect(created?.url).toBe("https://a.test/hook");
      expect(created?.description).toBe("first");
      expect(created?.metadata).toEqual({ team: "payments" });

      // Patch only some fields; the rest stay unchanged.
      await h().store.updateEndpoint(id, { url: "https://b.test/hook", metadata: { team: "ops" } });
      const updated = await h().store.findEndpoint(id);
      expect(updated?.url).toBe("https://b.test/hook");
      expect(updated?.metadata).toEqual({ team: "ops" });
      expect(updated?.description).toBe("first"); // untouched

      // Re-enable path (status + disabledAt) via updateEndpoint.
      await h().store.disableEndpoint(id, new Date());
      await h().store.updateEndpoint(id, { status: "active", disabledAt: null });
      const reEnabled = await h().store.findEndpoint(id);
      expect(reEnabled?.status).toBe("active");
      expect(reEnabled?.disabledAt).toBeNull();
    });

    it("completeAttempt records the ledger and applies the transition atomically (in_flight guard)", async () => {
      const r = sampleRow();
      await h().enqueue(r);
      await h().store.claimDue({ limit: 10, lockedBy: "w1", now: new Date() });

      await h().store.completeAttempt(
        {
          outboxId: r.id,
          attemptNo: 1,
          requestHeaders: { "webhook-id": r.id },
          responseStatus: 200,
          responseBodySnippet: "ok",
          durationMs: 5,
          error: null,
        },
        onSuccess(new Date()),
      );

      expect((await h().getOutbox(r.id))?.status).toBe("delivered");
      const attempts = await h().store.queryAttempts({ outboxId: r.id });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.responseStatus).toBe(200);

      // Guard: a second completeAttempt still appends the ledger row but does not transition
      // (row is no longer in_flight).
      await h().store.completeAttempt(
        {
          outboxId: r.id,
          attemptNo: 2,
          requestHeaders: {},
          responseStatus: 500,
          responseBodySnippet: null,
          durationMs: 1,
          error: "HTTP 500",
        },
        onSuccess(new Date()),
      );
      expect((await h().getOutbox(r.id))?.status).toBe("delivered"); // unchanged
      expect(await h().store.queryAttempts({ outboxId: r.id })).toHaveLength(2);
    });

    it("insertOutboxMany inserts every row, and enqueueMany rides the user TX (rollback discards all)", async () => {
      const committed = [sampleRow(), sampleRow(), sampleRow()];
      await h().enqueueMany(committed);
      for (const r of committed) expect(await h().getOutbox(r.id)).toBeDefined();

      const rolledBack = [sampleRow(), sampleRow()];
      await h().enqueueMany(rolledBack, { rollback: true });
      for (const r of rolledBack) expect(await h().getOutbox(r.id)).toBeUndefined();
    });

    it("stats reports status counts and the oldest pending timestamp", async () => {
      const t1 = new Date("2026-06-20T00:00:00.000Z");
      const t2 = new Date("2026-06-21T00:00:00.000Z");
      await h().enqueue(sampleRow({ status: "pending", availableAt: t2 }));
      await h().enqueue(sampleRow({ status: "pending", availableAt: t1 }));
      await h().enqueue(sampleRow({ status: "dead" }));

      const stats = await h().store.stats();
      expect(stats.counts.pending).toBe(2);
      expect(stats.counts.dead).toBe(1);
      expect(stats.counts.delivered).toBe(0); // zero-filled
      expect(stats.oldestPendingAt).toEqual(t1);
    });
  });
});
