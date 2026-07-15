/**
 * The fail-open instrumentation seam (v1.2, the OTel hook point): deliverOne calls `instrument(start)`
 * once before the attempt and the returned finaliser exactly once with the terminal event, carrying
 * secret-free `endpointId`/`host`. A throwing factory or finaliser is swallowed (fail-open) and never
 * breaks delivery. No Docker.
 */
import { describe, expect, it, vi } from "vitest";
import { deliverOne } from "../../src/delivery/deliver";
import type {
  DeliverDeps,
  DeliveryEvent,
  DeliveryInstrument,
  DeliveryStart,
} from "../../src/delivery/deliver";
import { resolveConfig } from "../../src/core/index";
import type { EndpointRow, OutboxRow } from "../../src/core/index";
import type { Store } from "../../src/store/store";

type HttpResult = Awaited<ReturnType<DeliverDeps["http"]["post"]>>;

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
  targetUrl: "https://example.test/hook?token=secret",
  secretSnapshot: "whsec_test",
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

function deps(opts: {
  result: HttpResult;
  instrument?: DeliveryInstrument;
  maxAttempts?: number;
  store?: Store;
  onError?: () => void;
}): DeliverDeps {
  const config = resolveConfig({
    retry: opts.maxAttempts != null ? { maxAttempts: opts.maxAttempts } : {},
    logger: { debug() {}, info() {}, warn() {}, error: opts.onError ?? (() => {}) },
  });
  return {
    store: opts.store ?? noopStore(),
    http: { post: () => Promise.resolve(opts.result) },
    config,
    clock: () => new Date(0),
    instrument: opts.instrument,
  };
}

const ok: HttpResult = {
  status: 200,
  bodySnippet: "ok",
  durationMs: 7,
  error: null,
  retryAfter: null,
};
const fail: HttpResult = {
  status: 500,
  bodySnippet: "e",
  durationMs: 9,
  error: null,
  retryAfter: null,
};
const gone: HttpResult = {
  status: 410,
  bodySnippet: "g",
  durationMs: 5,
  error: null,
  retryAfter: null,
};

/** A spying instrument: records the start and the single terminal event. */
function spyInstrument(): {
  instrument: DeliveryInstrument;
  starts: DeliveryStart[];
  events: DeliveryEvent[];
} {
  const starts: DeliveryStart[] = [];
  const events: DeliveryEvent[] = [];
  const instrument: DeliveryInstrument = (start) => {
    starts.push(start);
    return (event) => {
      events.push(event);
    };
  };
  return { instrument, starts, events };
}

describe("delivery instrumentation seam", () => {
  it("finalises exactly once with the terminal event on a 2xx (host is host-only, no query/secret)", async () => {
    const spy = spyInstrument();
    await deliverOne(row(), deps({ result: ok, instrument: spy.instrument }));
    expect(spy.starts).toHaveLength(1);
    expect(spy.events).toHaveLength(1);
    expect(spy.starts[0]).toMatchObject({
      id: row().id,
      attempt: 1,
      endpointId: null,
      host: "example.test",
    });
    expect(spy.events[0]).toMatchObject({
      status: 200,
      error: null,
      endpointId: null,
      host: "example.test",
    });
  });

  it("finalises once on a retry (attempts remain)", async () => {
    const spy = spyInstrument();
    await deliverOne(row(), deps({ result: fail, instrument: spy.instrument, maxAttempts: 12 }));
    expect(spy.events).toHaveLength(1);
    expect(spy.events[0]).toMatchObject({ status: 500, error: "HTTP 500" });
  });

  it("finalises once on dead (maxAttempts exhausted) and on 410", async () => {
    const a = spyInstrument();
    await deliverOne(row(), deps({ result: fail, instrument: a.instrument, maxAttempts: 1 }));
    expect(a.events).toHaveLength(1);

    const b = spyInstrument();
    await deliverOne(row(), deps({ result: gone, instrument: b.instrument, maxAttempts: 12 }));
    expect(b.events).toHaveLength(1);
    expect(b.events[0]).toMatchObject({ status: 410 });
  });

  it("refines host from the registered endpoint URL once resolved", async () => {
    const ep: EndpointRow = {
      id: "ep-1",
      url: "https://registered.test/incoming",
      secret: "whsec_x",
      secretSecondary: null,
      status: "active",
      description: null,
      consecutiveFailures: 0,
      disabledAt: null,
      metadata: null,
      customHeaders: null,
      createdAt: new Date(0),
    };
    const spy = spyInstrument();
    const store = noopStore({ findEndpoint: () => Promise.resolve(ep) });
    await deliverOne(
      row({ endpointId: "ep-1", targetUrl: null, secretSnapshot: null }),
      deps({ result: ok, instrument: spy.instrument, store }),
    );
    // Start has no host yet (resolved later); the terminal event carries the endpoint host.
    expect(spy.starts[0]?.host).toBeNull();
    expect(spy.events[0]).toMatchObject({ endpointId: "ep-1", host: "registered.test" });
  });

  it("is fail-open: a throwing factory is swallowed and delivery still completes", async () => {
    const onError = vi.fn();
    const instrument: DeliveryInstrument = () => {
      throw new Error("boom");
    };
    let completed = 0;
    const store = noopStore({
      completeAttempt: () => {
        completed++;
        return Promise.resolve({ transitionApplied: true });
      },
    });
    await deliverOne(row(), deps({ result: ok, instrument, store, onError }));
    expect(completed).toBe(1);
    expect(onError).toHaveBeenCalled();
  });

  it("is fail-open: a throwing finaliser is swallowed", async () => {
    const onError = vi.fn();
    const instrument: DeliveryInstrument = () => () => {
      throw new Error("finaliser boom");
    };
    let completed = 0;
    const store = noopStore({
      completeAttempt: () => {
        completed++;
        return Promise.resolve({ transitionApplied: true });
      },
    });
    await deliverOne(row(), deps({ result: ok, instrument, store, onError }));
    expect(completed).toBe(1);
    expect(onError).toHaveBeenCalled();
  });
});
