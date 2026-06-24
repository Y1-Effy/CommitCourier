/**
 * End-to-end suite (06-testing section 4): createRelay wired to a real pg store and a local HTTP
 * receiver. Proves the enqueue/dispatch/delivered path with a verifiable Standard Webhooks
 * signature and a ledger row, plus that observe mode records without ever sending. Requires Docker.
 */
import http from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { sign } from "../../src/core/index";
import { postgresStore } from "../../src/store/pg";
import type { Store } from "../../src/store/store";
import { createRelay } from "../../src/relay";
import { dockerAvailable, startPostgres, type PgConn } from "./_helpers";

interface Received {
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface TestServer {
  url: () => string;
  close: () => Promise<void>;
}

const servers: TestServer[] = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
});

function startServer(received: Received[]): Promise<TestServer> {
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
  const pools: Pool[] = [];

  function newPool(): Pool {
    const pool = new Pool(conn);
    pools.push(pool);
    return pool;
  }
  const newStore = (): Store<PoolClient> => postgresStore({ pool: newPool() });

  async function statusOf(pool: Pool, id: string): Promise<string | null> {
    const res = await pool.query("SELECT status FROM webhook_outbox WHERE id = $1", [id]);
    return (res.rows as { status: string }[])[0]?.status ?? null;
  }

  beforeAll(async () => {
    const started = await startPostgres();
    conn = started.conn;
    stop = started.stop;
    await newStore().migrate();
  });

  afterAll(async () => {
    for (const p of pools) await p.end();
    await stop();
  });

  it("delivers a row, signs it verifiably, and records the ledger", async () => {
    const received: Received[] = [];
    const srv = await startServer(received);
    const relay = await createRelay({ store: newStore(), ssrf: { allowlist: ["127.0.0.1"] } });

    const pool = newPool();
    const client = await pool.connect();
    let id: string;
    try {
      await client.query("BEGIN");
      ({ id } = await relay.enqueue(client, {
        eventType: "order.created",
        payload: { n: 1 },
        endpoint: { url: srv.url(), secret: "whsec_test" },
        idempotencyKey: "k1",
      }));
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    const dispatcher = relay.createDispatcher({ pollIntervalMs: 20 });
    await dispatcher.start();
    await waitFor(async () => (await statusOf(pool, id)) === "delivered");
    await dispatcher.stop();

    expect(received).toHaveLength(1);
    const attempts = await relay.attempts({ outboxId: id });
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.responseStatus).toBe(200);

    // The received body must validate against the signature headers (Standard Webhooks).
    const got = received[0]!;
    const ts = Number(got.headers["webhook-timestamp"]);
    const expected = await sign({ id, timestampSec: ts, body: got.body, secret: "whsec_test" });
    expect(got.headers["webhook-id"]).toBe(id);
    expect(got.headers["webhook-signature"]).toBe(expected["webhook-signature"]);
    expect(got.headers["idempotency-key"]).toBe("k1");
  });

  it("observe mode records observed and never sends", async () => {
    const received: Received[] = [];
    const srv = await startServer(received);
    const relay = await createRelay({
      store: newStore(),
      mode: "observe",
      ssrf: { allowlist: ["127.0.0.1"] },
    });
    const pool = newPool();

    const { id } = await relay.enqueueUnsafe({
      eventType: "order.created",
      payload: { n: 2 },
      endpoint: { url: srv.url(), secret: "whsec_test" },
    });
    expect(await statusOf(pool, id)).toBe("observed");

    const dispatcher = relay.createDispatcher({ pollIntervalMs: 20 });
    await dispatcher.start();
    await new Promise((r) => setTimeout(r, 200));
    await dispatcher.stop();

    expect(received).toHaveLength(0);
    expect(await statusOf(pool, id)).toBe("observed");
  });
});
