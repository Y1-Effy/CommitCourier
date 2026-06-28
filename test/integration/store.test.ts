/**
 * Store integration suite (06-testing section 4). The same assertions run against both the pg
 * and knex adapters to prove identical semantics. Requires Docker (testcontainers); skips
 * cleanly when none is available.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { onSuccess } from "../../src/core/index";
import type { NewDeliveryAttempt } from "../../src/store/store";
import {
  dockerAvailable,
  drizzleHarness,
  knexHarness,
  pgHarness,
  sampleRow,
  startPostgres,
  type Harness,
  type PgConn,
} from "./_helpers";

const HARNESS_NAMES = ["pg", "knex", "drizzle"] as const;

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
    harnesses.drizzle = drizzleHarness(conn);
    // Migrate once via one adapter; all share the same schema.
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

    it("per-endpoint FIFO holds the line: a backed-off head blocks later rows (head by seq)", async () => {
      const endpointId = randomUUID();
      await h().insertEndpoint({ id: endpointId, url: "https://ep.test/hook", secret: "s" });
      const now = new Date();
      // row1 is inserted first but backed off into the future (a failed head awaiting retry); row2 is
      // inserted later and already due. The head must be row1 (smallest seq), so the endpoint is
      // blocked until row1 is due — row2 must never jump ahead.
      const row1 = sampleRow({
        endpointId,
        targetUrl: null,
        secretSnapshot: null,
        availableAt: new Date(now.getTime() + 10 * 60_000),
      });
      await h().enqueue(row1);
      const row2 = sampleRow({
        endpointId,
        targetUrl: null,
        secretSnapshot: null,
        availableAt: new Date(now.getTime() - 1_000),
      });
      await h().enqueue(row2);

      // Head (row1) is not yet due → nothing is claimed for this endpoint.
      const blocked = await h().store.claimDue({
        limit: 10,
        lockedBy: "w1",
        now,
        ordering: "per-endpoint",
      });
      expect(blocked.map((r) => r.id)).not.toContain(row1.id);
      expect(blocked.map((r) => r.id)).not.toContain(row2.id);

      // Once row1 is due, the head (row1) is claimed first — never row2 ahead of it.
      const afterDue = await h().store.claimDue({
        limit: 10,
        lockedBy: "w2",
        now: new Date(now.getTime() + 11 * 60_000),
        ordering: "per-endpoint",
      });
      expect(afterDue.map((r) => r.id)).toEqual([row1.id]);
    });

    it("per-endpoint FIFO preserves arrival order within a single-transaction bulk enqueue", async () => {
      const endpointId = randomUUID();
      await h().insertEndpoint({ id: endpointId, url: "https://ep.test/hook", secret: "s" });
      const due = new Date(Date.now() - 1_000);
      // Three rows for one endpoint, all due, enqueued in ONE transaction → identical created_at and
      // random uuids. Only the monotonic `seq` distinguishes their arrival order; the head must follow
      // it so they are delivered in insertion order.
      const rows = [0, 1, 2].map(() =>
        sampleRow({ endpointId, targetUrl: null, secretSnapshot: null, availableAt: due }),
      );
      await h().enqueueMany(rows);

      // Claim one at a time (one in-flight per endpoint), completing each before the next is claimable.
      const claimedOrder: string[] = [];
      for (let i = 0; i < rows.length; i++) {
        const claimed = await h().store.claimDue({
          limit: 10,
          lockedBy: "w1",
          now: new Date(),
          ordering: "per-endpoint",
        });
        expect(claimed).toHaveLength(1);
        const id = claimed[0]!.id;
        claimedOrder.push(id);
        await h().store.applyTransition(id, onSuccess(new Date()));
      }
      expect(claimedOrder).toEqual(rows.map((r) => r.id));
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

    it("selectForReplay scopes to one endpoint when endpointId is given", async () => {
      const epA = randomUUID();
      const epB = randomUUID();
      const deadA = sampleRow({ status: "dead", endpointId: epA });
      const deadB = sampleRow({ status: "dead", endpointId: epB });
      await h().enqueue(deadA);
      await h().enqueue(deadB);

      const onlyA = await h().store.selectForReplay({ status: "dead", endpointId: epA });
      const ids = onlyA.map((r) => r.id);
      expect(ids).toContain(deadA.id);
      expect(ids).not.toContain(deadB.id);
    });

    it("selectForReplay never returns active (pending/in_flight) rows", async () => {
      const pending = sampleRow(); // defaults to pending
      const claimed = sampleRow();
      const dead = sampleRow({ status: "dead" });
      await h().enqueue(pending);
      await h().enqueue(claimed);
      await h().enqueue(dead);
      await h().setInFlight(claimed.id, new Date());

      // A no-filter replay selection must exclude live rows so they are not copied into duplicates.
      const all = await h().store.selectForReplay({});
      const ids = all.map((r) => r.id);
      expect(ids).toContain(dead.id);
      expect(ids).not.toContain(pending.id);
      expect(ids).not.toContain(claimed.id);
    });

    it("cancel moves only a pending row to cancelled (in_flight/terminal untouched)", async () => {
      const pending = sampleRow();
      await h().enqueue(pending);
      expect(await h().store.cancel(pending.id)).toBe(true);
      expect((await h().getOutbox(pending.id))?.status).toBe("cancelled");
      // A second cancel is a no-op (already terminal).
      expect(await h().store.cancel(pending.id)).toBe(false);

      // An in_flight row cannot be cancelled out from under a delivery.
      const claimed = sampleRow();
      await h().enqueue(claimed);
      await h().setInFlight(claimed.id, new Date());
      expect(await h().store.cancel(claimed.id)).toBe(false);
      expect((await h().getOutbox(claimed.id))?.status).toBe("in_flight");

      // Unknown id is a clean false.
      expect(await h().store.cancel(randomUUID())).toBe(false);
    });

    it("getOutbox returns a secret-free row by id, or null when unknown", async () => {
      const row = sampleRow({ idempotencyKey: "idem-9" });
      await h().enqueue(row);
      const item = await h().store.getOutbox(row.id);
      expect(item?.id).toBe(row.id);
      expect(item?.status).toBe("pending");
      expect(item?.idempotencyKey).toBe("idem-9");
      expect(typeof item?.seq).toBe("string");
      // The list-item shape carries no signing snapshot.
      expect(item).not.toHaveProperty("secretSnapshot");
      expect(await h().store.getOutbox(randomUUID())).toBeNull();
    });

    it("circuit breaker: noteEndpointFailure increments then auto-disables; success resets", async () => {
      const epId = randomUUID();
      await h().insertEndpoint({ id: epId, url: "https://ep.test/hook", secret: "s" });
      const now = new Date();

      await h().store.noteEndpointFailure(epId, now, 3);
      await h().store.noteEndpointFailure(epId, now, 3);
      let ep = await h().store.findEndpoint(epId);
      expect(ep?.consecutiveFailures).toBe(2);
      expect(ep?.status).toBe("active"); // not yet at the threshold

      // A success resets the counter without disabling.
      await h().store.noteEndpointSuccess(epId);
      ep = await h().store.findEndpoint(epId);
      expect(ep?.consecutiveFailures).toBe(0);
      expect(ep?.status).toBe("active");

      // Three consecutive failures reach the threshold and auto-disable atomically.
      await h().store.noteEndpointFailure(epId, now, 3);
      await h().store.noteEndpointFailure(epId, now, 3);
      await h().store.noteEndpointFailure(epId, now, 3);
      ep = await h().store.findEndpoint(epId);
      expect(ep?.consecutiveFailures).toBe(3);
      expect(ep?.status).toBe("disabled");
      expect(ep?.disabledAt).toBeInstanceOf(Date);
    });

    it("reactivateEndpoint resets the breaker counter so a re-enabled endpoint regains its full budget", async () => {
      // admin.enableEndpoint routes through reactivateEndpoint (see admin-operability.test.ts); this
      // proves the underlying SQL clears the marker AND resets consecutive_failures end-to-end (NF1) —
      // otherwise the next failure would re-disable the endpoint immediately.
      const epId = randomUUID();
      await h().insertEndpoint({ id: epId, url: "https://ep.test/hook", secret: "s" });
      const now = new Date();
      // Trip the breaker (threshold 3) so the endpoint is disabled with consecutive_failures at 3.
      await h().store.noteEndpointFailure(epId, now, 3);
      await h().store.noteEndpointFailure(epId, now, 3);
      await h().store.noteEndpointFailure(epId, now, 3);
      let ep = await h().store.findEndpoint(epId);
      expect(ep?.status).toBe("disabled");
      expect(ep?.consecutiveFailures).toBe(3);

      await h().store.reactivateEndpoint(epId);
      ep = await h().store.findEndpoint(epId);
      expect(ep?.status).toBe("active");
      expect(ep?.disabledAt).toBeNull();
      expect(ep?.consecutiveFailures).toBe(0);

      // One subsequent failure does NOT re-disable: the endpoint has its full threshold budget back.
      await h().store.noteEndpointFailure(epId, now, 3);
      ep = await h().store.findEndpoint(epId);
      expect(ep?.status).toBe("active");
      expect(ep?.consecutiveFailures).toBe(1);
    });

    it("selectForReplay honours an explicit limit (replay safety cap)", async () => {
      for (let i = 0; i < 5; i++) await h().enqueue(sampleRow({ status: "dead" }));
      const capped = await h().store.selectForReplay({ status: "dead", limit: 2 });
      expect(capped).toHaveLength(2);
      const all = await h().store.selectForReplay({ status: "dead" });
      expect(all).toHaveLength(5);
    });

    it("prune deletes only the requested terminal statuses and cascades ledger attempts", async () => {
      // created_at defaults to now() at insert, so a future cutoff makes every row time-eligible;
      // the status filter then decides what is actually deleted.
      const delivered = sampleRow({ status: "delivered" });
      const dead = sampleRow({ status: "dead" });
      const cancelled = sampleRow({ status: "cancelled" });
      const observed = sampleRow({ status: "observed" });
      const pending = sampleRow({ status: "pending" });
      for (const r of [delivered, dead, cancelled, observed, pending]) await h().enqueue(r);
      // A ledger row on the dead outbox row proves ON DELETE CASCADE.
      await h().store.recordAttempt({
        outboxId: dead.id,
        attemptNo: 1,
        requestHeaders: {},
        responseStatus: 500,
        responseBodySnippet: null,
        durationMs: 1,
        error: "HTTP 500",
      });

      const future = new Date(Date.now() + 60_000);
      const { deleted } = await h().store.prune({
        olderThan: future,
        statuses: ["delivered", "dead", "cancelled"],
        limit: 1_000,
      });
      expect(deleted).toBe(3); // delivered/dead/cancelled only

      expect(await h().getOutbox(delivered.id)).toBeUndefined();
      expect(await h().getOutbox(dead.id)).toBeUndefined();
      expect(await h().getOutbox(cancelled.id)).toBeUndefined();
      // The dead row's ledger attempts cascaded away.
      expect(await h().store.queryAttempts({ outboxId: dead.id })).toHaveLength(0);
      // Out-of-scope status (observed) and active rows survive.
      expect(await h().getOutbox(observed.id)).toBeDefined();
      expect(await h().getOutbox(pending.id)).toBeDefined();
    });

    it("prune respects the olderThan cutoff (a past cutoff deletes nothing)", async () => {
      const dead = sampleRow({ status: "dead" });
      await h().enqueue(dead);
      const past = new Date("2020-01-01T00:00:00.000Z");
      const { deleted } = await h().store.prune({
        olderThan: past,
        statuses: ["dead"],
        limit: 100,
      });
      expect(deleted).toBe(0);
      expect(await h().getOutbox(dead.id)).toBeDefined();
    });

    it("prune bounds each call by limit (delete the rest on the next call)", async () => {
      for (let i = 0; i < 5; i++) await h().enqueue(sampleRow({ status: "dead" }));
      const future = new Date(Date.now() + 60_000);
      const first = await h().store.prune({ olderThan: future, statuses: ["dead"], limit: 2 });
      expect(first.deleted).toBe(2);
      const second = await h().store.prune({ olderThan: future, statuses: ["dead"], limit: 100 });
      expect(second.deleted).toBe(3);
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

      const first = await h().store.completeAttempt(
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
        "w1",
      );
      expect(first.transitionApplied).toBe(true); // this worker owned the row

      expect((await h().getOutbox(r.id))?.status).toBe("delivered");
      const attempts = await h().store.queryAttempts({ outboxId: r.id });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.responseStatus).toBe(200);

      // Guard: a second completeAttempt still appends the ledger row but does not transition
      // (row is no longer in_flight), and reports transitionApplied=false.
      const second = await h().store.completeAttempt(
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
        "w1",
      );
      expect(second.transitionApplied).toBe(false); // no row matched the in_flight guard
      expect((await h().getOutbox(r.id))?.status).toBe("delivered"); // unchanged
      expect(await h().store.queryAttempts({ outboxId: r.id })).toHaveLength(2);
    });

    it("completeAttempt with a stale locked_by appends the ledger but does not transition", async () => {
      const r = sampleRow();
      await h().enqueue(r);
      await h().store.claimDue({ limit: 10, lockedBy: "w1", now: new Date() });

      const attempt = (n: number): NewDeliveryAttempt => ({
        outboxId: r.id,
        attemptNo: n,
        requestHeaders: {},
        responseStatus: 200,
        responseBodySnippet: "ok",
        durationMs: 1,
        error: null,
      });

      // A worker that no longer holds the lock (e.g. the row was reclaimed and re-locked by another
      // worker) must NOT transition the row, even though it is still in_flight, and must report
      // transitionApplied=false. The ledger row is still recorded so the attempt is not lost.
      const stale = await h().store.completeAttempt(attempt(1), onSuccess(new Date()), "w-stale");
      expect(stale.transitionApplied).toBe(false);
      expect((await h().getOutbox(r.id))?.status).toBe("in_flight"); // not transitioned
      expect(await h().store.queryAttempts({ outboxId: r.id })).toHaveLength(1); // ledger recorded

      // The worker that actually holds the lock transitions it and reports transitionApplied=true.
      const owner = await h().store.completeAttempt(attempt(2), onSuccess(new Date()), "w1");
      expect(owner.transitionApplied).toBe(true);
      expect((await h().getOutbox(r.id))?.status).toBe("delivered");
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

    it("listOutbox returns dead rows newest-first, secret-free, and pages by the seq cursor", async () => {
      // Three dead rows (the DLQ) plus a pending row that must be filtered out. Enqueued in order,
      // so seq increases d1 < d2 < d3; newest-first lists them d3, d2, d1.
      const d1 = sampleRow({ status: "dead" });
      const d2 = sampleRow({ status: "dead" });
      const d3 = sampleRow({ status: "dead" });
      await h().enqueue(d1);
      await h().enqueue(d2);
      await h().enqueue(d3);
      await h().enqueue(sampleRow({ status: "pending" }));

      const all = await h().store.listOutbox({ status: "dead" });
      expect(all.items.map((r) => r.id)).toEqual([d3.id, d2.id, d1.id]);
      expect(all.nextCursor).toBeNull();
      // Secret-free and carries the cursor key.
      const first = all.items[0]!;
      expect(first).not.toHaveProperty("secretSnapshot");
      expect(typeof first.seq).toBe("string");

      // Page 1 of 2 returns a cursor; page 2 returns the remainder and a null cursor.
      const page1 = await h().store.listOutbox({ status: "dead", limit: 2 });
      expect(page1.items.map((r) => r.id)).toEqual([d3.id, d2.id]);
      expect(page1.nextCursor).not.toBeNull();
      const page2 = await h().store.listOutbox({
        status: "dead",
        limit: 2,
        cursor: page1.nextCursor!,
      });
      expect(page2.items.map((r) => r.id)).toEqual([d1.id]);
      expect(page2.nextCursor).toBeNull();
    });

    it("listEndpoints returns secret-free summaries and filters by status", async () => {
      const a = sampleRow().id;
      const b = sampleRow().id;
      await h().store.insertEndpoint({ id: a, url: "https://a.test/h", secret: "whsec_a" });
      await h().store.insertEndpoint({ id: b, url: "https://b.test/h", secret: "whsec_b" });
      await h().store.disableEndpoint(b, new Date());

      const all = await h().store.listEndpoints({});
      expect(all.items.map((e) => e.id).sort()).toEqual([a, b].sort());
      for (const e of all.items) {
        expect(e).not.toHaveProperty("secret");
        expect(e).not.toHaveProperty("secretSecondary");
      }

      const disabled = await h().store.listEndpoints({ status: "disabled" });
      expect(disabled.items.map((e) => e.id)).toEqual([b]);
      expect(disabled.items[0]?.disabledAt).toBeInstanceOf(Date);
    });
  });
});
