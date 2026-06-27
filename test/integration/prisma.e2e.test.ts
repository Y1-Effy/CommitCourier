/**
 * Prisma adapter end-to-end suite (06-testing section 4): `createRelay` wired to a real Prisma client
 * (driver-adapter / query-compiler mode) and a local HTTP receiver. Proves the
 * enqueue→dispatch→delivered path with a verifiable signature and ledger row, key-rotation
 * dual-signing, and immediate 410 invalidation — over a real Postgres.
 *
 * Requires Docker AND a generated Prisma client (`prisma generate --schema prisma/schema.prisma`,
 * output `test/integration/.prisma-client`, which is gitignored). The suite self-skips when either is
 * missing, so the default `npm test` stays green on a fresh checkout that has not run codegen.
 */
import http from "node:http";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { sign } from "../../src/core/index";
import { prismaStore, type PrismaTx } from "../../src/store/prisma";
import { createRelay } from "../../src/relay";
import type { Relay } from "../../src/relay";
import type { EnqueueInput } from "../../src/core/index";
import { dockerAvailable, startPostgres, type PgConn } from "./_helpers";

const CLIENT_PATH = fileURLToPath(new URL("./.prisma-client/client.ts", import.meta.url));
const prismaClientAvailable = existsSync(CLIENT_PATH);

interface Received {
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface Responder {
  url: () => string;
  close: () => Promise<void>;
  setResponse: (r: { status: number; headers?: Record<string, string> }) => void;
}

function startResponder(received: Received[]): Promise<Responder> {
  let resp: { status: number; headers: Record<string, string> } = { status: 200, headers: {} };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.writeHead(resp.status, resp.headers);
      res.end("ok");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({
        url: () => `http://127.0.0.1:${String(port)}/`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
        setResponse: (r) => (resp = { status: r.status, headers: r.headers ?? {} }),
      });
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

describe.skipIf(!dockerAvailable() || !prismaClientAvailable)(
  "prisma adapter e2e (integration)",
  () => {
    let conn: PgConn;
    let stop: () => Promise<void>;
    let admin: Pool;
    // The generated client is dynamically typed; `any` is confined to this test seam.
    /* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
    let prisma: any;
    let api: Relay<PrismaTx>;
    const servers: Responder[] = [];

    const statusOf = async (id: string): Promise<string | null> => {
      const res = await admin.query("SELECT status FROM webhook_outbox WHERE id = $1", [id]);
      return (res.rows as { status: string }[])[0]?.status ?? null;
    };
    const endpointStatusOf = async (id: string): Promise<string | null> => {
      const res = await admin.query("SELECT status FROM webhook_endpoints WHERE id = $1", [id]);
      return (res.rows as { status: string }[])[0]?.status ?? null;
    };
    const enqueueCommitted = async (input: EnqueueInput): Promise<{ id: string }> =>
      (await prisma.$transaction((tx: PrismaTx) => api.enqueue(tx, input))) as { id: string };

    beforeAll(async () => {
      const started = await startPostgres();
      conn = started.conn;
      stop = started.stop;
      admin = new Pool(conn);

      // Non-literal specifier so tsc neither resolves the generated `.ts` path nor fails on a fresh
      // checkout that has not run codegen (the suite is already guarded by `prismaClientAvailable`).
      const clientModule: { PrismaClient: new (opts: unknown) => unknown } = await import(
        new URL("./.prisma-client/client.ts", import.meta.url).href
      );
      const { PrismaClient } = clientModule;
      const { PrismaPg } = await import("@prisma/adapter-pg");
      const adapter = new PrismaPg({
        host: conn.host,
        port: conn.port,
        user: conn.user,
        password: conn.password,
        database: conn.database,
      });
      prisma = new PrismaClient({ adapter });

      const store = prismaStore({ prisma });
      await store.migrate();
      api = await createRelay({ store, ssrf: { allowlist: ["127.0.0.1"] } });
    });

    afterEach(async () => {
      while (servers.length > 0) await servers.pop()?.close();
      await admin.query(
        "TRUNCATE webhook_delivery_attempts, webhook_outbox, webhook_endpoints RESTART IDENTITY CASCADE",
      );
    });

    afterAll(async () => {
      await prisma?.$disconnect?.();
      await admin.end();
      await stop();
    });

    it("delivers a row, signs it verifiably, and records the ledger", async () => {
      const received: Received[] = [];
      const srv = await startResponder(received);
      servers.push(srv);

      const { id } = await enqueueCommitted({
        eventType: "order.created",
        payload: { n: 1 },
        endpoint: { url: srv.url(), secret: "whsec_test" },
        idempotencyKey: "k1",
      });

      const dispatcher = api.createDispatcher({ pollIntervalMs: 20 });
      await dispatcher.start();
      await waitFor(async () => (await statusOf(id)) === "delivered");
      await dispatcher.stop();

      expect(received).toHaveLength(1);
      const attempts = await api.attempts({ outboxId: id });
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.responseStatus).toBe(200);

      const got = received[0]!;
      const ts = Number(got.headers["webhook-timestamp"]);
      const expected = await sign({
        id,
        timestampSec: ts,
        body: got.body,
        secrets: ["whsec_test"],
      });
      expect(got.headers["webhook-signature"]).toBe(expected["webhook-signature"]);
      expect(got.headers["idempotency-key"]).toBe("k1");
    });

    it("dual-signs with both keys after a rotation (current key first)", async () => {
      const received: Received[] = [];
      const srv = await startResponder(received);
      servers.push(srv);

      const { id: endpointId } = await api.endpoints.register({
        url: srv.url(),
        secret: "whsec_old",
      });
      await api.endpoints.rotateSecret(endpointId, "whsec_new");
      const { id } = await enqueueCommitted({
        eventType: "order.created",
        payload: { n: 2 },
        endpoint: { endpointId },
      });

      const dispatcher = api.createDispatcher({ pollIntervalMs: 20 });
      await dispatcher.start();
      await waitFor(async () => (await statusOf(id)) === "delivered");
      await dispatcher.stop();

      const got = received[0]!;
      const ts = Number(got.headers["webhook-timestamp"]);
      const withNew = await sign({ id, timestampSec: ts, body: got.body, secrets: ["whsec_new"] });
      const withOld = await sign({ id, timestampSec: ts, body: got.body, secrets: ["whsec_old"] });
      expect(got.headers["webhook-signature"]).toBe(
        `${withNew["webhook-signature"]} ${withOld["webhook-signature"]}`,
      );
    });

    it("treats 410 Gone as permanent: row -> dead and the endpoint is disabled", async () => {
      const received: Received[] = [];
      const srv = await startResponder(received);
      srv.setResponse({ status: 410 });
      servers.push(srv);

      const { id: endpointId } = await api.endpoints.register({
        url: srv.url(),
        secret: "whsec_test",
      });
      const { id } = await enqueueCommitted({
        eventType: "order.created",
        payload: { n: 3 },
        endpoint: { endpointId },
      });

      const dispatcher = api.createDispatcher({ pollIntervalMs: 20 });
      await dispatcher.start();
      await waitFor(async () => (await statusOf(id)) === "dead");
      await dispatcher.stop();

      expect(received).toHaveLength(1);
      expect(await endpointStatusOf(endpointId)).toBe("disabled");
    });

    it("list / endpoints.list page secret-free over real Prisma (seq-cursor cast included)", async () => {
      // Seed two dead rows directly; the IDENTITY seq increments d1 < d2, so newest-first is d2, d1.
      const seedDead = async (): Promise<string> => {
        const id = randomUUID();
        await admin.query(
          `INSERT INTO webhook_outbox
             (id, event_type, payload, target_url, secret_snapshot, status, attempts, available_at)
           VALUES ($1, 'order.created', '{"n":1}'::jsonb, 'https://x.test/h', 'whsec', 'dead', 3, now())`,
          [id],
        );
        return id;
      };
      const d1 = await seedDead();
      const d2 = await seedDead();
      const { id: epId } = await api.endpoints.register({
        url: "https://x.test/h",
        secret: "whsec_x",
      });

      // Page 1 (newest first) returns d2 and a cursor; page 2 uses the seq cursor (::bigint cast path).
      const page1 = await api.list({ status: "dead", limit: 1 });
      expect(page1.items.map((r) => r.id)).toEqual([d2]);
      expect(page1.items[0]).not.toHaveProperty("secretSnapshot");
      expect(typeof page1.items[0]?.seq).toBe("string");
      expect(page1.nextCursor).not.toBeNull();

      const page2 = await api.list({ status: "dead", limit: 1, cursor: page1.nextCursor! });
      expect(page2.items.map((r) => r.id)).toEqual([d1]);

      // endpoints.list is secret-free.
      const eps = await api.endpoints.list({});
      const found = eps.items.find((e) => e.id === epId);
      expect(found).toBeTruthy();
      expect(found).not.toHaveProperty("secret");
    });
    /* eslint-enable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
  },
);
