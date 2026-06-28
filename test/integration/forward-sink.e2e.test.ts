/**
 * End-to-end suite for the `sink` transport (08-forward-sink), parametrized over the pg/knex/drizzle
 * adapters: createRelay wired to a real store with a mock sink. Proves the parts the unit tests bypass
 * by hand-building OutboxRows — the real enqueue→migrate(002)→claim→deliverSink→ledger flow:
 *   - a target-less row (no endpoint) is INSERTed and delivered through the sink (migration 002),
 *   - idempotencyKey is forwarded and the provider message id is recorded in the ledger,
 *   - retryable:false goes straight to the DLQ, a throwing sink is fail-open (pending/retry),
 *   - an orphaned in_flight row is reclaimed and delivered (at-least-once for target-less rows),
 *   - replay re-sends a dead sink row inheriting its idempotency key,
 *   - a rolled-back business TX leaves no row and never calls the sink (dual-write guarantee).
 * Requires Docker; skips cleanly without it.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { postgresStore } from "../../src/store/pg";
import { dockerAvailable, newPgPool, startPostgres, type PgConn } from "./_helpers";
import { RELAY_ADAPTERS, type RelayHarness } from "./_relay-helpers";
import type { Logger } from "../../src/core/index";
import type { Sink, SinkEvent, SinkResult } from "../../src/forward/index";

/** A no-op logger so createRelay's startup warnings (no cipher, sink delegation) stay off the console. */
function silentLogger(): Logger {
  return { debug() {}, info() {}, warn() {}, error() {} };
}

interface MockSink {
  sink: Sink;
  calls: SinkEvent[];
}

/**
 * Build an in-memory sink that records every event. By default it succeeds with a fixed provider id;
 * pass `result` to return a specific outcome, or `throwError` to simulate a throwing/failing adapter.
 */
function mockSink(opts: { result?: SinkResult; throwError?: Error } = {}): MockSink {
  const calls: SinkEvent[] = [];
  const sink: Sink = {
    deliver(event) {
      calls.push(event);
      if (opts.throwError) return Promise.reject(opts.throwError);
      return Promise.resolve(opts.result ?? { providerMessageId: "prov-1" });
    },
  };
  return { sink, calls };
}

describe.skipIf(!dockerAvailable())("forward sink e2e (integration)", () => {
  let conn: PgConn;
  let stop: () => Promise<void>;
  let admin: Pool;
  const harnesses: RelayHarness[] = [];

  const statusOf = async (id: string): Promise<string | null> => {
    const res = await admin.query("SELECT status FROM webhook_outbox WHERE id = $1", [id]);
    return (res.rows as { status: string }[])[0]?.status ?? null;
  };

  const rowOf = async (id: string): Promise<Record<string, unknown> | null> => {
    const res = await admin.query("SELECT * FROM webhook_outbox WHERE id = $1", [id]);
    return (res.rows as Record<string, unknown>[])[0] ?? null;
  };

  const countRows = async (): Promise<number> => {
    const res = await admin.query("SELECT count(*)::int AS n FROM webhook_outbox");
    return (res.rows as { n: number }[])[0]?.n ?? 0;
  };

  beforeAll(async () => {
    const started = await startPostgres();
    conn = started.conn;
    stop = started.stop;
    admin = newPgPool(conn);
    // Applies 001_init AND 002_sink_targetless (drops the target CHECK so a sink row can be target-less).
    await postgresStore({ pool: admin }).migrate();
  });

  beforeEach(async () => {
    await admin.query(
      "TRUNCATE webhook_delivery_attempts, webhook_outbox, webhook_endpoints RESTART IDENTITY CASCADE",
    );
  });

  afterEach(async () => {
    while (harnesses.length > 0) await harnesses.pop()?.teardown();
  });

  afterAll(async () => {
    await admin.end();
    await stop();
  });

  describe.each(RELAY_ADAPTERS)("%s adapter", (_name, makeRelay) => {
    const harness = async (mock: MockSink): Promise<RelayHarness> => {
      const h = await makeRelay(conn, {
        delivery: { transport: "sink" },
        sink: mock.sink,
        logger: silentLogger(),
      });
      harnesses.push(h);
      return h;
    };

    it("enqueues a target-less row (no endpoint) and delivers it through the sink", async () => {
      const mock = mockSink();
      const h = await harness(mock);

      const { id } = await h.enqueueCommitted({
        eventType: "order.created",
        payload: { n: 1 },
        idempotencyKey: "k1",
      });

      // The row is genuinely target-less: this INSERT only succeeds because migration 002 dropped the
      // CHECK (endpoint_id IS NOT NULL OR target_url IS NOT NULL).
      const row = await rowOf(id);
      expect(row?.endpoint_id).toBeNull();
      expect(row?.target_url).toBeNull();
      expect(row?.secret_snapshot).toBeNull();

      const res = await h.api.dispatchOnce();
      expect(res.processed).toBe(1);
      expect(await statusOf(id)).toBe("delivered");

      expect(mock.calls).toHaveLength(1);
      const event = mock.calls[0]!;
      expect(event.idempotencyKey).toBe("k1");
      expect(event.eventType).toBe("order.created");
      expect(event.payload).toEqual({ n: 1 });
      expect(event.endpointId).toBeNull();

      const attempts = await h.api.attempts({ outboxId: id });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.error).toBeNull();
      expect(attempts[0]?.requestHeaders["provider-message-id"]).toBe("prov-1");
    });

    it("sends a row to the DLQ when the sink returns retryable:false", async () => {
      const mock = mockSink({ result: { error: "rejected", retryable: false } });
      const h = await harness(mock);

      const { id } = await h.enqueueCommitted({ eventType: "order.created", payload: { n: 2 } });
      await h.api.dispatchOnce();

      expect(await statusOf(id)).toBe("dead");
      const attempts = await h.api.attempts({ outboxId: id });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.error).toBe("rejected");
    });

    it("is fail-open when the sink throws: the row stays pending and is retried", async () => {
      const mock = mockSink({
        throwError: Object.assign(new Error("boom"), { code: "ETIMEDOUT" }),
      });
      const h = await harness(mock);

      const { id } = await h.enqueueCommitted({ eventType: "order.created", payload: { n: 3 } });
      // dispatchOnce is fail-open: it must not throw even though the sink does.
      const res = await h.api.dispatchOnce();
      expect(res.processed).toBe(1);

      expect(await statusOf(id)).toBe("pending");
      const attempts = await h.api.attempts({ outboxId: id });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.error).toBe("ETIMEDOUT");
    });

    it("reclaims an orphaned in_flight sink row and delivers it (at-least-once)", async () => {
      const mock = mockSink();
      const h = await harness(mock);

      const { id } = await h.enqueueCommitted({
        eventType: "order.created",
        payload: { n: 4 },
        idempotencyKey: "k4",
      });
      // Simulate a worker that claimed the row then crashed before settling it: in_flight with a stale
      // lock far older than the default 5-min visibility timeout.
      await admin.query(
        "UPDATE webhook_outbox SET status='in_flight', locked_at=$2, locked_by='dead-worker' WHERE id=$1",
        [id, new Date("2020-01-01T00:00:00.000Z")],
      );

      // runOnce reclaims stale in_flight rows before draining (reclaim defaults to true).
      await h.api.dispatchOnce();

      expect(await statusOf(id)).toBe("delivered");
      expect(mock.calls).toHaveLength(1);
      expect(mock.calls[0]?.idempotencyKey).toBe("k4");
    });

    it("replays a dead sink row as a fresh target-less delivery inheriting the idempotency key", async () => {
      const mock = mockSink();
      const h = await harness(mock);

      // A dead, target-less row (as a sink failure would leave it).
      await h.store.insertOutboxAutonomous({
        id: randomUUID(),
        eventType: "order.created",
        payload: { n: 5 },
        endpointId: null,
        targetUrl: null,
        secretSnapshot: null,
        status: "dead",
        attempts: 12,
        availableAt: new Date(),
        idempotencyKey: "replay-key",
      });

      const { ids } = await h.api.replay({ filter: { status: "dead" } });
      expect(ids).toHaveLength(1);

      await h.api.dispatchOnce();

      expect(await statusOf(ids[0]!)).toBe("delivered");
      expect(mock.calls).toHaveLength(1);
      expect(mock.calls[0]?.idempotencyKey).toBe("replay-key");
    });

    it("rolls the enqueue back with the business TX: no row, and the sink is never called", async () => {
      const mock = mockSink();
      const h = await harness(mock);

      await h.enqueueWithBusiness({ eventType: "order.created", payload: { n: 6 } }, "SELECT 1", {
        rollback: true,
      });

      expect(await countRows()).toBe(0);
      const res = await h.api.dispatchOnce();
      expect(res.processed).toBe(0);
      expect(mock.calls).toHaveLength(0);
    });
  });
});
