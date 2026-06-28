/**
 * `sink` transport (08-forward-sink): deliverOne hands the row to the configured Sink, maps the
 * SinkResult onto delivered/retry/dead, forwards idempotencyKey, records the provider id, and stays
 * fail-open (a throwing sink never throws out of deliverOne). No HTTP/signing/SSRF. No Docker.
 */
import { describe, expect, it, vi } from "vitest";
import { deliverOne } from "../../src/delivery/deliver";
import type { DeliverDeps } from "../../src/delivery/deliver";
import type { CriticalLogger } from "../../src/delivery/critical";
import type { Sink, SinkEvent } from "../../src/forward/index";
import { resolveConfig } from "../../src/core/index";
import type { OutboxRow, Transition } from "../../src/core/index";
import type { Store, NewDeliveryAttempt } from "../../src/store/store";

const noopStore = (over: Partial<Store> = {}): Store => ({
  insertOutbox: () => Promise.resolve(),
  insertOutboxMany: () => Promise.resolve(),
  insertOutboxAutonomous: () => Promise.resolve(),
  claimDue: () => Promise.resolve([]),
  applyTransition: () => Promise.resolve(),
  cancel: () => Promise.resolve(false),
  getOutbox: () => Promise.resolve(null),
  prune: () => Promise.resolve({ deleted: 0 }),
  noteEndpointSuccess: () => Promise.resolve(),
  noteEndpointFailure: () => Promise.resolve(),
  reactivateEndpoint: () => Promise.resolve(),
  reclaimStuck: () => Promise.resolve(0),
  recordAttempt: () => Promise.resolve(),
  completeAttempt: () => Promise.resolve({ transitionApplied: true }),
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
});

const row = (over: Partial<OutboxRow> = {}): OutboxRow => ({
  id: "11111111-1111-1111-1111-111111111111",
  eventType: "order.created",
  payload: { a: 1 },
  endpointId: null,
  targetUrl: null,
  secretSnapshot: null,
  status: "in_flight",
  attempts: 0,
  availableAt: new Date(0),
  lockedAt: new Date(0),
  lockedBy: "w",
  idempotencyKey: null,
  lastError: null,
  createdAt: new Date(0),
  dispatchedAt: null,
  ...over,
});

/** Capture what deliverOne writes: the ledger attempt, the transition, and any dataLoss event. */
interface Captured {
  attempt: NewDeliveryAttempt | null;
  transition: Transition | null;
  dataLoss: number;
}

function deps(opts: {
  sink?: Sink;
  maxAttempts?: number;
  timeoutMs?: number;
  captured?: Captured;
}): DeliverDeps {
  const config = resolveConfig({
    delivery: {
      transport: "sink",
      ...(opts.timeoutMs != null ? { timeoutMs: opts.timeoutMs } : {}),
    },
    retry: opts.maxAttempts != null ? { maxAttempts: opts.maxAttempts } : {},
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const cap = opts.captured;
  const critical: CriticalLogger = {
    securityBlocked: () => {},
    dataLoss: () => {
      if (cap) cap.dataLoss += 1;
    },
  };
  const store = noopStore({
    completeAttempt: (attempt, transition) => {
      if (cap) {
        cap.attempt = attempt;
        cap.transition = transition;
      }
      return Promise.resolve({ transitionApplied: true });
    },
  });
  return {
    store,
    // http is unused in sink mode; a throwing stub proves it is never called.
    http: {
      post: () => {
        throw new Error("http.post must not be called in sink mode");
      },
    },
    config,
    clock: () => new Date(0),
    critical,
    sink: opts.sink,
  };
}

describe("sink transport delivery", () => {
  it("maps a successful SinkResult to delivered and records the provider message id", async () => {
    const cap: Captured = { attempt: null, transition: null, dataLoss: 0 };
    const sink: Sink = { deliver: () => Promise.resolve({ providerMessageId: "msg_42" }) };
    await deliverOne(row(), deps({ sink, captured: cap }));
    expect(cap.transition?.status).toBe("delivered");
    expect(cap.attempt?.requestHeaders).toEqual({ "provider-message-id": "msg_42" });
    expect(cap.attempt?.error).toBeNull();
    expect(cap.dataLoss).toBe(0);
  });

  it("forwards the idempotencyKey to the sink event", async () => {
    const seen: SinkEvent[] = [];
    const sink: Sink = {
      deliver: (e) => {
        seen.push(e);
        return Promise.resolve({});
      },
    };
    await deliverOne(row({ idempotencyKey: "idem-1" }), deps({ sink }));
    expect(seen[0]?.idempotencyKey).toBe("idem-1");
    expect(seen[0]?.id).toBe("11111111-1111-1111-1111-111111111111");
  });

  it("passes idempotencyKey as undefined (not null) when the row has none", async () => {
    const seen: SinkEvent[] = [];
    const sink: Sink = {
      deliver: (e) => {
        seen.push(e);
        return Promise.resolve({});
      },
    };
    await deliverOne(row({ idempotencyKey: null }), deps({ sink }));
    expect(seen[0]?.idempotencyKey).toBeUndefined();
  });

  it("sends retryable:false straight to dead and fires a data-loss event", async () => {
    const cap: Captured = { attempt: null, transition: null, dataLoss: 0 };
    const sink: Sink = {
      deliver: () => Promise.resolve({ error: "rejected", retryable: false }),
    };
    // maxAttempts high so this can only be `dead` via the permanent path, not exhaustion.
    await deliverOne(row(), deps({ sink, maxAttempts: 12, captured: cap }));
    expect(cap.transition?.status).toBe("dead");
    expect(cap.attempt?.error).toBe("rejected");
    expect(cap.dataLoss).toBe(1);
  });

  it("retries a 5xx-equivalent status while attempts remain", async () => {
    const cap: Captured = { attempt: null, transition: null, dataLoss: 0 };
    const sink: Sink = { deliver: () => Promise.resolve({ status: 503, error: "busy" }) };
    await deliverOne(row({ attempts: 0 }), deps({ sink, maxAttempts: 12, captured: cap }));
    expect(cap.transition?.status).toBe("pending");
    expect(cap.dataLoss).toBe(0);
  });

  it("moves to dead with a data-loss event when retries are exhausted", async () => {
    const cap: Captured = { attempt: null, transition: null, dataLoss: 0 };
    const sink: Sink = { deliver: () => Promise.resolve({ status: 503 }) };
    // attempts already at max-1, so this attempt is the last.
    await deliverOne(row({ attempts: 2 }), deps({ sink, maxAttempts: 3, captured: cap }));
    expect(cap.transition?.status).toBe("dead");
    expect(cap.dataLoss).toBe(1);
  });

  it("treats a permanent (410) status as immediate dead", async () => {
    const cap: Captured = { attempt: null, transition: null, dataLoss: 0 };
    const sink: Sink = { deliver: () => Promise.resolve({ status: 410 }) };
    await deliverOne(row(), deps({ sink, maxAttempts: 12, captured: cap }));
    expect(cap.transition?.status).toBe("dead");
    expect(cap.dataLoss).toBe(1);
  });

  it("normalises a throwing sink to a retryable failure (fail-open, never throws)", async () => {
    const cap: Captured = { attempt: null, transition: null, dataLoss: 0 };
    const err = Object.assign(new Error("boom"), { code: "ETIMEDOUT" });
    const sink: Sink = {
      deliver: () => {
        throw err;
      },
    };
    await expect(
      deliverOne(row(), deps({ sink, maxAttempts: 12, captured: cap })),
    ).resolves.toBeUndefined();
    expect(cap.transition?.status).toBe("pending");
    // secret-free summary prefers the error code.
    expect(cap.attempt?.error).toBe("ETIMEDOUT");
  });

  it("does not invoke the HTTP client in sink mode", async () => {
    const post = vi.fn();
    const sink: Sink = { deliver: () => Promise.resolve({}) };
    const d = deps({ sink });
    d.http = { post };
    await deliverOne(row(), d);
    expect(post).not.toHaveBeenCalled();
  });

  it("times out a hung sink (bounded by delivery.timeoutMs) as a retryable failure", async () => {
    const cap: Captured = { attempt: null, transition: null, dataLoss: 0 };
    // A sink that never settles; the delivery.timeoutMs bound must cut it short.
    const sink: Sink = { deliver: () => new Promise<never>(() => {}) };
    await deliverOne(row(), deps({ sink, timeoutMs: 10, maxAttempts: 12, captured: cap }));
    expect(cap.transition?.status).toBe("pending");
    expect(cap.attempt?.error).toBe("SINK_TIMEOUT");
    expect(cap.dataLoss).toBe(0);
  });

  it("normalises an undefined sink result to a retryable failure (no TypeError)", async () => {
    const cap: Captured = { attempt: null, transition: null, dataLoss: 0 };
    // A contract-violating adapter resolving to a non-SinkResult.
    const sink = { deliver: () => Promise.resolve(undefined) } as unknown as Sink;
    await deliverOne(row(), deps({ sink, maxAttempts: 12, captured: cap }));
    expect(cap.transition?.status).toBe("pending");
    expect(cap.attempt?.error).toBe("SINK_BAD_RESULT");
    expect(cap.dataLoss).toBe(0);
  });

  it("does not classify a non-object sink result as success", async () => {
    const cap: Captured = { attempt: null, transition: null, dataLoss: 0 };
    // A stray string must NOT be read as success (that would be a silent data loss).
    const sink = { deliver: () => Promise.resolve("ok") } as unknown as Sink;
    await deliverOne(row(), deps({ sink, maxAttempts: 12, captured: cap }));
    expect(cap.transition?.status).toBe("pending");
    expect(cap.attempt?.error).toBe("SINK_BAD_RESULT");
  });
});
