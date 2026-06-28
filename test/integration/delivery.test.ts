/**
 * Delivery integration suite (06-testing section 6). Exercises the real undici client against a
 * local node:http server with an in-memory fake Store. Needs only localhost networking, so it
 * runs without Docker (unlike the store suite).
 */
import http from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/core/index";
import type { OutboxRow, RelayConfig } from "../../src/core/index";
import type { Transition } from "../../src/core/state";
import type { Store, NewDeliveryAttempt } from "../../src/store/store";
import { createHttpClient } from "../../src/delivery/http";
import type { ResolveAll } from "../../src/delivery/http";
import { deliverOne } from "../../src/delivery/deliver";
import type { DeliverDeps } from "../../src/delivery/deliver";

const NOW = "2026-06-25T00:00:00.000Z";
type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void;

interface TestServer {
  port: number;
  url: (host?: string) => string;
  close: () => Promise<void>;
}

const servers: TestServer[] = [];

afterEach(async () => {
  while (servers.length > 0) {
    await servers.pop()?.close();
  }
});

function startServer(handler: Handler): Promise<TestServer> {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      const srv: TestServer = {
        port,
        url: (host = "127.0.0.1") => `http://${host}:${String(port)}/`,
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

interface Captured {
  attempts: NewDeliveryAttempt[];
  transitions: { id: string; t: Transition }[];
}

function fakeStore(over: Partial<Store> = {}): { store: Store; captured: Captured } {
  const captured: Captured = { attempts: [], transitions: [] };
  const store: Store = {
    insertOutbox: () => Promise.resolve(),
    insertOutboxMany: () => Promise.resolve(),
    insertOutboxAutonomous: () => Promise.resolve(),
    claimDue: () => Promise.resolve([]),
    applyTransition: (id, t) => {
      captured.transitions.push({ id, t });
      return Promise.resolve();
    },
    cancel: () => Promise.resolve(false),
    getOutbox: () => Promise.resolve(null),
    prune: () => Promise.resolve({ deleted: 0 }),
    noteEndpointSuccess: () => Promise.resolve(),
    noteEndpointFailure: () => Promise.resolve(),
    reactivateEndpoint: () => Promise.resolve(),
    reclaimStuck: () => Promise.resolve(0),
    recordAttempt: (a) => {
      captured.attempts.push(a);
      return Promise.resolve();
    },
    completeAttempt: (a, t) => {
      // The dispatch path uses the combined op; capture both halves for the assertions.
      captured.attempts.push(a);
      captured.transitions.push({ id: a.outboxId, t });
      return Promise.resolve({ transitionApplied: true });
    },
    queryAttempts: () => Promise.resolve([]),
    selectForReplay: () => Promise.resolve([]),
    insertReplayCopies: () => Promise.resolve([]),
    listOutbox: () => Promise.resolve({ items: [], nextCursor: null }),
    listEndpoints: () => Promise.resolve({ items: [], nextCursor: null }),
    insertEndpoint: () => Promise.resolve(),
    updateEndpoint: () => Promise.resolve(),
    findEndpoint: () => Promise.resolve(null),
    disableEndpoint: () => Promise.resolve(),
    stats: () =>
      Promise.resolve({
        counts: { pending: 0, in_flight: 0, delivered: 0, dead: 0, observed: 0, cancelled: 0 },
        oldestPendingAt: null,
      }),
    diagnose: () => Promise.resolve({ ok: true, missingTables: [] }),
    migrate: () => Promise.resolve(),
    ...over,
  };
  return { store, captured };
}

function outboxRow(over: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: randomUUID(),
    eventType: "order.created",
    payload: { hello: "world" },
    endpointId: null,
    targetUrl: null,
    secretSnapshot: "test-secret",
    status: "in_flight",
    attempts: 0,
    availableAt: new Date(NOW),
    lockedAt: new Date(NOW),
    lockedBy: "w1",
    idempotencyKey: null,
    lastError: null,
    createdAt: new Date(NOW),
    dispatchedAt: null,
    ...over,
  };
}

function makeDeps(store: Store, config: RelayConfig, resolveAll?: ResolveAll): DeliverDeps {
  const http = createHttpClient(
    { ssrf: config.ssrf, delivery: config.delivery },
    resolveAll ? { resolveAll } : {},
  );
  return { store, http, config, clock: config.clock };
}

const respond =
  (status: number, body = "ok"): Handler =>
  (_req, res) => {
    res.writeHead(status);
    res.end(body);
  };

describe("deliverOne (integration)", () => {
  it("delivers a 2xx response and marks the row delivered", async () => {
    const srv = await startServer(respond(200));
    const config = resolveConfig({ ssrf: { allowlist: ["127.0.0.1"] } });
    const { store, captured } = fakeStore();

    await deliverOne(outboxRow({ targetUrl: srv.url() }), makeDeps(store, config));

    expect(captured.attempts).toHaveLength(1);
    expect(captured.attempts[0]?.responseStatus).toBe(200);
    expect(captured.attempts[0]?.requestHeaders["webhook-signature"]).toMatch(/^v1,/);
    expect(captured.transitions[0]?.t.status).toBe("delivered");
  });

  it("blocks a loopback destination with SSRF and schedules a retry", async () => {
    const srv = await startServer(respond(200));
    const config = resolveConfig({}); // default allowlist [], blockPrivateRanges true
    const { store, captured } = fakeStore();

    await deliverOne(outboxRow({ targetUrl: srv.url() }), makeDeps(store, config));

    expect(captured.attempts[0]?.error).toMatch(/^SSRF_BLOCKED:/);
    expect(captured.attempts[0]?.responseStatus).toBeNull();
    expect(captured.transitions[0]?.t.status).toBe("pending");
  });

  it("blocks DNS rebinding: a public name resolving to a private IP is rejected", async () => {
    const srv = await startServer(respond(200));
    const config = resolveConfig({});
    const resolveAll: ResolveAll = (_host, cb) => {
      cb(null, [{ address: "10.0.0.1", family: 4 }]);
    };
    const { store, captured } = fakeStore();

    await deliverOne(
      outboxRow({ targetUrl: `http://evil.test:${String(srv.port)}/` }),
      makeDeps(store, config, resolveAll),
    );

    expect(captured.attempts[0]?.error).toBe("SSRF_BLOCKED:private");
    expect(captured.transitions[0]?.t.status).toBe("pending");
  });

  it("records a timeout when the server is too slow", async () => {
    const srv = await startServer((_req, res) => {
      const t = setTimeout(() => {
        res.writeHead(200);
        res.end("late");
      }, 2000);
      t.unref();
      // Cancel the late response once the (aborted) connection closes, so the timer can never
      // fire against a destroyed ServerResponse on a slow run.
      res.on("close", () => {
        clearTimeout(t);
      });
    });
    const config = resolveConfig({
      ssrf: { allowlist: ["127.0.0.1"] },
      delivery: { timeoutMs: 80 },
    });
    const { store, captured } = fakeStore();

    await deliverOne(outboxRow({ targetUrl: srv.url() }), makeDeps(store, config));

    expect(captured.attempts[0]?.error).toBe("TIMEOUT");
    expect(captured.transitions[0]?.t.status).toBe("pending");
  });

  it("keeps a 2xx status when the body read stalls past the timeout (no false retry)", async () => {
    // Headers arrive immediately, then the body stalls open (a small chunk below bodySnippetBytes,
    // never ended). The delivery timeout fires mid-stream: the status must remain authoritative so a
    // receiver that already accepted (200) is not redelivered to.
    const srv = await startServer((_req, res) => {
      res.writeHead(200);
      res.write("partial"); // < bodySnippetBytes, so readSnippet keeps waiting until the abort
      // intentionally no res.end(): the connection is torn down by the client abort / afterEach.
    });
    const config = resolveConfig({
      ssrf: { allowlist: ["127.0.0.1"] },
      delivery: { timeoutMs: 80 },
    });
    const { store, captured } = fakeStore();

    await deliverOne(outboxRow({ targetUrl: srv.url() }), makeDeps(store, config));

    expect(captured.attempts[0]?.responseStatus).toBe(200);
    expect(captured.attempts[0]?.error).toBeNull();
    expect(captured.transitions[0]?.t.status).toBe("delivered");
  });

  it("treats 5xx as a retryable failure", async () => {
    const srv = await startServer(respond(500, "boom"));
    const config = resolveConfig({ ssrf: { allowlist: ["127.0.0.1"] } });
    const { store, captured } = fakeStore();

    await deliverOne(outboxRow({ targetUrl: srv.url() }), makeDeps(store, config));

    expect(captured.attempts[0]?.responseStatus).toBe(500);
    expect(captured.attempts[0]?.error).toBe("HTTP 500");
    expect(captured.transitions[0]?.t.status).toBe("pending");
  });

  it("moves to dead once maxAttempts is reached", async () => {
    const srv = await startServer(respond(500));
    const config = resolveConfig({ ssrf: { allowlist: ["127.0.0.1"] } });
    const { store, captured } = fakeStore();
    const row = outboxRow({ targetUrl: srv.url(), attempts: config.retry.maxAttempts - 1 });

    await deliverOne(row, makeDeps(store, config));

    expect(captured.transitions[0]?.t.status).toBe("dead");
  });

  it("truncates the body snippet to bodySnippetBytes", async () => {
    const srv = await startServer(respond(200, "a".repeat(5000)));
    const config = resolveConfig({ ssrf: { allowlist: ["127.0.0.1"] } });
    const { store, captured } = fakeStore();

    await deliverOne(outboxRow({ targetUrl: srv.url() }), makeDeps(store, config));

    expect(captured.attempts[0]?.responseBodySnippet?.length).toBe(
      config.delivery.bodySnippetBytes,
    );
  });

  it("fails closed-over a missing endpoint without throwing", async () => {
    const config = resolveConfig({});
    const { store, captured } = fakeStore();

    await expect(
      deliverOne(outboxRow({ endpointId: randomUUID() }), makeDeps(store, config)),
    ).resolves.toBeUndefined();

    expect(captured.attempts[0]?.error).toBe("ENDPOINT_NOT_FOUND");
    expect(captured.transitions[0]?.t.status).toBe("pending");
  });

  it("stays fail-open when the store throws (records a retry, never throws)", async () => {
    const config = resolveConfig({});
    const { store, captured } = fakeStore({
      findEndpoint: () => Promise.reject(new Error("db down")),
    });

    await expect(
      deliverOne(outboxRow({ endpointId: randomUUID() }), makeDeps(store, config)),
    ).resolves.toBeUndefined();

    expect(captured.attempts).toHaveLength(1);
    expect(captured.transitions[0]?.t.status).toBe("pending");
  });
});
