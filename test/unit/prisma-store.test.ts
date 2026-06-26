/**
 * Docker-free unit coverage for the Prisma adapter's SQL/param contract, exercised against a fake
 * Prisma raw client that records calls. This proves the adapter emits the shared dialect SQL with the
 * right positional values, stringifies jsonb params, reuses the per-endpoint claim variant, and
 * splits the multi-statement DDL — without a live database (those paths are covered end-to-end by the
 * pg/knex/drizzle integration suites the adapter mirrors).
 */
import { describe, expect, it } from "vitest";
import { prismaStore, type PrismaClientLike, type PrismaRaw } from "../../src/store/prisma";
import type { NewOutboxRow } from "../../src/store/store";

interface Call {
  query: string;
  values: unknown[];
}

/** A fake Prisma client that records every raw call and serves canned query rows. */
class FakePrisma implements PrismaClientLike {
  calls: Call[] = [];
  rows: unknown[] = [];

  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T[]> {
    this.calls.push({ query, values });
    return Promise.resolve(this.rows as T[]);
  }
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number> {
    this.calls.push({ query, values });
    return Promise.resolve(1);
  }
  $transaction<T>(fn: (tx: PrismaRaw) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

const row = (over: Partial<NewOutboxRow> = {}): NewOutboxRow => ({
  id: "11111111-1111-1111-1111-111111111111",
  eventType: "order.created",
  payload: { n: 1 },
  endpointId: null,
  targetUrl: "https://example.test/hook",
  secretSnapshot: "whsec_test",
  status: "pending",
  attempts: 0,
  availableAt: new Date(0),
  idempotencyKey: null,
  ...over,
});

describe("prismaStore", () => {
  it("claimDue passes the global claim SQL verbatim with [now, limit, lockedBy]", async () => {
    const fake = new FakePrisma();
    const store = prismaStore({ prisma: fake });
    const now = new Date(1000);
    await store.claimDue({ limit: 5, lockedBy: "w1", now });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.query).toContain("FOR UPDATE SKIP LOCKED");
    expect(fake.calls[0]!.query).not.toContain("DISTINCT ON");
    expect(fake.calls[0]!.values).toEqual([now, 5, "w1"]);
  });

  it("claimDue with ordering=per-endpoint uses the per-endpoint claim SQL", async () => {
    const fake = new FakePrisma();
    const store = prismaStore({ prisma: fake });
    await store.claimDue({ limit: 3, lockedBy: "w2", now: new Date(0), ordering: "per-endpoint" });
    expect(fake.calls[0]!.query).toContain("DISTINCT ON (endpoint_id)");
    expect(fake.calls[0]!.query).toContain("FOR UPDATE OF o SKIP LOCKED");
  });

  it("claimDue maps returned raw rows to domain OutboxRow shape", async () => {
    const fake = new FakePrisma();
    fake.rows = [
      {
        id: "abc",
        event_type: "e",
        payload: { a: 1 },
        endpoint_id: null,
        target_url: "https://x.test",
        secret_snapshot: "s",
        status: "in_flight",
        attempts: 0,
        available_at: new Date(0),
        locked_at: new Date(0),
        locked_by: "w",
        idempotency_key: null,
        last_error: null,
        created_at: new Date(0),
        dispatched_at: null,
      },
    ];
    const store = prismaStore({ prisma: fake });
    const [mapped] = await store.claimDue({ limit: 1, lockedBy: "w", now: new Date(0) });
    expect(mapped).toMatchObject({ id: "abc", eventType: "e", targetUrl: "https://x.test" });
  });

  it("insertOutbox stringifies the jsonb payload param (Prisma binds it as text + ::jsonb)", async () => {
    const fake = new FakePrisma();
    const store = prismaStore({ prisma: fake });
    await store.insertOutbox(fake, row({ payload: { hello: "world" } }));
    const call = fake.calls[0]!;
    expect(call.query).toContain("payload");
    expect(call.query).toContain("::jsonb");
    expect(call.values).toContain(JSON.stringify({ hello: "world" }));
  });

  it("completeAttempt passes the combined ledger+transition CTE with id last", async () => {
    const fake = new FakePrisma();
    const store = prismaStore({ prisma: fake });
    await store.completeAttempt(
      {
        outboxId: "out-1",
        attemptNo: 1,
        requestHeaders: { a: "b" },
        responseStatus: 200,
        responseBodySnippet: "ok",
        durationMs: 5,
        error: null,
      },
      { status: "delivered", dispatchedAt: new Date(0), lockedAt: null, lockedBy: null },
    );
    const call = fake.calls[0]!;
    expect(call.query).toContain("WITH ins AS");
    expect(call.query).toContain("status = 'in_flight'");
    // request_headers is stringified for the jsonb column.
    expect(call.values).toContain(JSON.stringify({ a: "b" }));
    // outboxId is the final bound value (the UPDATE's WHERE id).
    expect(call.values[call.values.length - 1]).toBe("out-1");
  });

  it("migrate splits the DDL into individual statements (no trailing semicolons)", async () => {
    const fake = new FakePrisma();
    const store = prismaStore({ prisma: fake });
    await store.migrate();
    expect(fake.calls.length).toBeGreaterThan(1);
    for (const c of fake.calls) {
      expect(c.query).not.toContain(";");
      expect(c.query.trim().length).toBeGreaterThan(0);
    }
    // The schema's tables and the v1.1 additions are all present across the statements.
    const all = fake.calls.map((c) => c.query).join("\n");
    expect(all).toContain("CREATE TABLE IF NOT EXISTS webhook_outbox");
    expect(all).toContain("secret_secondary");
    expect(all).toContain("ix_outbox_ep_head");
  });

  it("stats coerces the bigint count and zero-fills missing statuses", async () => {
    const fake = new FakePrisma();
    const store = prismaStore({ prisma: fake });
    // First call (GROUP BY status) returns counts as bigint; second (min) returns oldest.
    let call = 0;
    fake.$queryRawUnsafe = <T = unknown>(_query: string): Promise<T[]> => {
      call++;
      const rows = call === 1 ? [{ status: "pending", count: 2n }] : [{ oldest: new Date(7) }];
      return Promise.resolve(rows as T[]);
    };
    const stats = await store.stats();
    expect(stats.counts.pending).toBe(2);
    expect(stats.counts.delivered).toBe(0);
    expect(stats.oldestPendingAt).toEqual(new Date(7));
  });
});
