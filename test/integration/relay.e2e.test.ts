/**
 * End-to-end suite (06-testing section 4), parametrized over the pg and knex adapters: createRelay
 * wired to a real store and a local HTTP receiver. Proves the enqueue/dispatch/delivered path with
 * a verifiable Standard Webhooks signature and a ledger row, that observe mode records without ever
 * sending, and that replay re-sends a dead row inheriting its idempotency key. Requires Docker.
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { sign } from "../../src/core/index";
import { postgresStore } from "../../src/store/pg";
import { dockerAvailable, startPostgres, type PgConn } from "./_helpers";
import { RELAY_ADAPTERS, type RelayHarness } from "./_relay-helpers";

interface Received {
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface TestServer {
  url: () => string;
  close: () => Promise<void>;
}

function startServer(received: Received[], servers: TestServer[]): Promise<TestServer> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.writeHead(200);
      res.end("ok");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      const srv: TestServer = {
        url: () => `http://127.0.0.1:${String(port)}/`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => {
              done();
            });
          }),
      };
      servers.push(srv);
      resolve(srv);
    });
  });
}

async function waitFor(cond: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe.skipIf(!dockerAvailable())("relay e2e (integration)", () => {
  let conn: PgConn;
  let stop: () => Promise<void>;
  let admin: Pool;
  const harnesses: RelayHarness[] = [];
  const servers: TestServer[] = [];

  const statusOf = async (id: string): Promise<string | null> => {
    const res = await admin.query("SELECT status FROM webhook_outbox WHERE id = $1", [id]);
    return (res.rows as { status: string }[])[0]?.status ?? null;
  };

  beforeAll(async () => {
    const started = await startPostgres();
    conn = started.conn;
    stop = started.stop;
    admin = new Pool(conn);
    await postgresStore({ pool: admin }).migrate();
  });

  beforeEach(async () => {
    await admin.query(
      "TRUNCATE webhook_delivery_attempts, webhook_outbox, webhook_endpoints RESTART IDENTITY CASCADE",
    );
  });

  afterEach(async () => {
    while (servers.length > 0) await servers.pop()?.close();
    while (harnesses.length > 0) await harnesses.pop()?.teardown();
  });

  afterAll(async () => {
    await admin.end();
    await stop();
  });

  describe.each(RELAY_ADAPTERS)("%s adapter", (_name, makeRelay) => {
    const harness = async (init: Parameters<typeof makeRelay>[1] = {}): Promise<RelayHarness> => {
      const h = await makeRelay(conn, init);
      harnesses.push(h);
      return h;
    };

    it("delivers a row, signs it verifiably, and records the ledger", async () => {
      const received: Received[] = [];
      const srv = await startServer(received, servers);
      const h = await harness({ ssrf: { allowlist: ["127.0.0.1"] } });

      const { id } = await h.enqueueCommitted({
        eventType: "order.created",
        payload: { n: 1 },
        endpoint: { url: srv.url(), secret: "whsec_test" },
        idempotencyKey: "k1",
      });

      const dispatcher = h.api.createDispatcher({ pollIntervalMs: 20 });
      await dispatcher.start();
      await waitFor(async () => (await statusOf(id)) === "delivered");
      await dispatcher.stop();

      expect(received).toHaveLength(1);
      const attempts = await h.api.attempts({ outboxId: id });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.responseStatus).toBe(200);

      const got = received[0]!;
      const ts = Number(got.headers["webhook-timestamp"]);
      const expected = await sign({ id, timestampSec: ts, body: got.body, secret: "whsec_test" });
      expect(got.headers["webhook-id"]).toBe(id);
      expect(got.headers["webhook-signature"]).toBe(expected["webhook-signature"]);
      expect(got.headers["idempotency-key"]).toBe("k1");
    });

    it("observe mode records observed and never sends", async () => {
      const received: Received[] = [];
      const srv = await startServer(received, servers);
      const h = await harness({ mode: "observe", ssrf: { allowlist: ["127.0.0.1"] } });

      const { id } = await h.api.enqueueUnsafe({
        eventType: "order.created",
        payload: { n: 2 },
        endpoint: { url: srv.url(), secret: "whsec_test" },
      });
      expect(await statusOf(id)).toBe("observed");

      const dispatcher = h.api.createDispatcher({ pollIntervalMs: 20 });
      await dispatcher.start();
      await new Promise((r) => setTimeout(r, 200));
      await dispatcher.stop();

      expect(received).toHaveLength(0);
      expect(await statusOf(id)).toBe("observed");
    });

    it("replay re-sends a dead row as a fresh delivery inheriting the idempotency key", async () => {
      const received: Received[] = [];
      const srv = await startServer(received, servers);
      const h = await harness({ ssrf: { allowlist: ["127.0.0.1"] } });

      await h.store.insertOutboxAutonomous({
        id: randomUUID(),
        eventType: "order.created",
        payload: { n: 3 },
        endpointId: null,
        targetUrl: srv.url(),
        secretSnapshot: "whsec_test",
        status: "dead",
        attempts: 12,
        availableAt: new Date(),
        idempotencyKey: "replay-key",
      });

      const { ids } = await h.api.replay({ filter: { status: "dead" } });
      expect(ids).toHaveLength(1);

      const dispatcher = h.api.createDispatcher({ pollIntervalMs: 20 });
      await dispatcher.start();
      await waitFor(async () => (await statusOf(ids[0]!)) === "delivered");
      await dispatcher.stop();

      expect(received).toHaveLength(1);
      expect(received[0]!.headers["idempotency-key"]).toBe("replay-key");
    });
  });
});
