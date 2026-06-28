/**
 * Fault-injection suite (06-testing section 6): proves the dead-letter path and enqueue atomicity
 * (core guarantee 3) against a real store. Crash recovery (core guarantee 2) is covered by the
 * concurrency suite; fail-open by the dispatcher/delivery suites. Requires Docker.
 */
import http from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { postgresStore } from "../../src/store/pg";
import { dockerAvailable, newPgPool, startPostgres, type PgConn } from "../integration/_helpers";
import {
  pgRelay,
  RELAY_ADAPTERS,
  type RelayConfigInit,
  type RelayHarness,
} from "../integration/_relay-helpers";

interface TestServer {
  url: () => string;
  close: () => Promise<void>;
}

/** A server that always answers with the given status (no body inspection needed). */
function startServer(status: number, servers: TestServer[]): Promise<TestServer> {
  const server = http.createServer((_req, res) => {
    res.writeHead(status);
    res.end("nope");
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

/** A server that resets the connection on every request (no response) to simulate a transport error. */
function startResettingServer(servers: TestServer[]): Promise<TestServer> {
  const server = http.createServer((req) => {
    req.socket.destroy();
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
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe.skipIf(!dockerAvailable())("fault injection (integration)", () => {
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
    admin = newPgPool(conn);
    await postgresStore({ pool: admin }).migrate();
    await admin.query("CREATE TABLE IF NOT EXISTS e2e_business (id text PRIMARY KEY)");
  });

  beforeEach(async () => {
    await admin.query(
      "TRUNCATE webhook_delivery_attempts, webhook_outbox, webhook_endpoints, e2e_business RESTART IDENTITY CASCADE",
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

  it("retries a continuously failing endpoint up to maxAttempts, then dead-letters it", async () => {
    const srv = await startServer(500, servers);
    const h = await pgRelay(conn, {
      ssrf: { allowlist: ["127.0.0.1"] },
      retry: { maxAttempts: 3, baseMs: 1, capMs: 5, jitter: 0 },
    });
    harnesses.push(h);

    const { id } = await h.enqueueCommitted({
      eventType: "order.created",
      payload: { n: 1 },
      endpoint: { url: srv.url(), secret: "whsec_test" },
    });

    const dispatcher = h.api.createDispatcher({ pollIntervalMs: 10 });
    await dispatcher.start();
    await waitFor(async () => (await statusOf(id)) === "dead");
    await dispatcher.stop();

    const attempts = await h.api.attempts({ outboxId: id });
    expect(attempts).toHaveLength(3);
    expect(attempts.every((a) => a.responseStatus === 500)).toBe(true);
  });

  it("retries a connection-reset (transport error) endpoint, then dead-letters it", async () => {
    const srv = await startResettingServer(servers);
    const h = await pgRelay(conn, {
      ssrf: { allowlist: ["127.0.0.1"] },
      retry: { maxAttempts: 2, baseMs: 1, capMs: 5, jitter: 0 },
    });
    harnesses.push(h);

    const { id } = await h.enqueueCommitted({
      eventType: "order.created",
      payload: { n: 1 },
      endpoint: { url: srv.url(), secret: "whsec_test" },
    });

    const dispatcher = h.api.createDispatcher({ pollIntervalMs: 10 });
    await dispatcher.start();
    await waitFor(async () => (await statusOf(id)) === "dead");
    await dispatcher.stop();

    const attempts = await h.api.attempts({ outboxId: id });
    expect(attempts).toHaveLength(2);
    // A transport failure carries no HTTP response: status is null and the error is a network
    // summary, not an "HTTP nnn" status-code label (that label is only used for a real response).
    expect(attempts.every((a) => a.responseStatus === null)).toBe(true);
    expect(attempts.every((a) => a.error != null && !a.error.startsWith("HTTP "))).toBe(true);
  });

  describe.each(RELAY_ADAPTERS)("%s adapter enqueue atomicity", (_name, makeRelay) => {
    const harness = async (init: RelayConfigInit = {}): Promise<RelayHarness> => {
      const h = await makeRelay(conn, init);
      harnesses.push(h);
      return h;
    };
    const input = {
      eventType: "order.created",
      payload: { n: 1 },
      endpoint: { url: "https://x.test/hook", secret: "whsec_test" },
    };

    it("commit persists both the business row and the outbox row", async () => {
      const h = await harness();
      await h.enqueueWithBusiness(input, "INSERT INTO e2e_business (id) VALUES ('biz-commit')", {
        rollback: false,
      });
      expect(await h.query("SELECT id FROM e2e_business WHERE id = 'biz-commit'")).toHaveLength(1);
      expect(await h.query("SELECT id FROM webhook_outbox")).toHaveLength(1);
    });

    it("rollback discards both the business row and the outbox row", async () => {
      const h = await harness();
      await h.enqueueWithBusiness(input, "INSERT INTO e2e_business (id) VALUES ('biz-rollback')", {
        rollback: true,
      });
      expect(await h.query("SELECT id FROM e2e_business WHERE id = 'biz-rollback'")).toHaveLength(
        0,
      );
      expect(await h.query("SELECT id FROM webhook_outbox")).toHaveLength(0);
    });
  });
});
