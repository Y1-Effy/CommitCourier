/**
 * Stale-worker safety (public-review #4): when `completeAttempt` reports `transitionApplied: false`
 * — the guarded UPDATE matched no row because this worker lost its lease to a visibility-timeout
 * reclaim — the delivery path must NOT fire success/retry/dead hooks, endpoint-health/breaker
 * updates, or dead-letter alarms. The ledger attempt is still recorded and the instrumentation still
 * settles. The winning worker owns the final state. No Docker (http + store are faked).
 */
import { describe, expect, it, vi } from "vitest";
import { deliverOne } from "../../src/delivery/deliver";
import type { DeliverDeps, DeliveryHooks } from "../../src/delivery/deliver";
import { resolveConfig } from "../../src/core/index";
import type { OutboxRow, EndpointRow, RelayConfig } from "../../src/core/index";
import type { Store } from "../../src/store/store";

type HttpResult = Awaited<ReturnType<DeliverDeps["http"]["post"]>>;

const ENDPOINT_ID = "22222222-2222-2222-2222-222222222222";

function endpoint(): EndpointRow {
  return {
    id: ENDPOINT_ID,
    url: "https://example.test/hook",
    secret: "whsec_dGVzdA",
    secretSecondary: null,
    status: "active",
    description: null,
    consecutiveFailures: 0,
    disabledAt: null,
    metadata: null,
    createdAt: new Date(0),
  };
}

interface Calls {
  completed: number;
  success: string[];
  failure: string[];
  disabled: string[];
}

/** A store whose `completeAttempt` reports the given `transitionApplied`, tracking side-effect calls. */
function fakeStore(transitionApplied: boolean): { store: Store; calls: Calls } {
  const calls: Calls = { completed: 0, success: [], failure: [], disabled: [] };
  const store = {
    findEndpoint: () => Promise.resolve(endpoint()),
    completeAttempt: () => {
      calls.completed++;
      return Promise.resolve({ transitionApplied });
    },
    disableEndpoint: (id: string) => Promise.resolve(void calls.disabled.push(id)),
    noteEndpointSuccess: (id: string) => Promise.resolve(void calls.success.push(id)),
    noteEndpointFailure: (id: string) => Promise.resolve(void calls.failure.push(id)),
  } as unknown as Store;
  return { store, calls };
}

function deps(
  store: Store,
  result: HttpResult,
  config: RelayConfig,
  hooks: DeliveryHooks,
): DeliverDeps {
  return {
    store,
    http: { post: () => Promise.resolve(result) },
    config,
    clock: () => new Date(0),
    hooks,
  };
}

const ok: HttpResult = {
  status: 200,
  bodySnippet: "",
  durationMs: 1,
  error: null,
  retryAfter: null,
};
const fail500: HttpResult = {
  status: 500,
  bodySnippet: "",
  durationMs: 1,
  error: null,
  retryAfter: null,
};
const gone410: HttpResult = {
  status: 410,
  bodySnippet: "",
  durationMs: 1,
  error: null,
  retryAfter: null,
};

const registeredRow = (): OutboxRow => ({
  id: "11111111-1111-1111-1111-111111111111",
  eventType: "order.created",
  payload: { a: 1 },
  endpointId: ENDPOINT_ID,
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
});

const breakerOn = resolveConfig({
  circuitBreaker: { failureThreshold: 3 },
  logger: { debug() {}, info() {}, warn() {}, error() {} },
});

const makeHooks = (): DeliveryHooks => ({
  onDelivered: vi.fn(),
  onRetry: vi.fn(),
  onDead: vi.fn(),
});

describe("stale worker: completeAttempt reports transitionApplied=false", () => {
  it("on a 2xx success, fires no onDelivered and no endpoint-health reset, but still records the attempt", async () => {
    const { store, calls } = fakeStore(false);
    const hooks = makeHooks();
    await deliverOne(registeredRow(), deps(store, ok, breakerOn, hooks));
    expect(calls.completed).toBe(1); // ledger attempt still recorded
    expect(hooks.onDelivered).not.toHaveBeenCalled();
    expect(calls.success).toHaveLength(0); // no breaker reset
  });

  it("on a retryable 5xx, fires no onRetry and no endpoint-failure increment", async () => {
    const { store, calls } = fakeStore(false);
    const hooks = makeHooks();
    await deliverOne(registeredRow(), deps(store, fail500, breakerOn, hooks));
    expect(calls.completed).toBe(1);
    expect(hooks.onRetry).not.toHaveBeenCalled();
    expect(calls.failure).toHaveLength(0); // no breaker increment
  });

  it("on a 410 Gone, fires no onDead and does not disable the endpoint", async () => {
    const { store, calls } = fakeStore(false);
    const hooks = makeHooks();
    await deliverOne(registeredRow(), deps(store, gone410, breakerOn, hooks));
    expect(calls.completed).toBe(1);
    expect(hooks.onDead).not.toHaveBeenCalled();
    expect(calls.disabled).toHaveLength(0);
  });

  it("still settles the instrumentation seam on a stale success (the HTTP attempt happened)", async () => {
    const { store } = fakeStore(false);
    const finish = vi.fn();
    const d = {
      ...deps(store, ok, breakerOn, makeHooks()),
      instrument: () => finish,
    } satisfies DeliverDeps;
    await deliverOne(registeredRow(), d);
    expect(finish).toHaveBeenCalledTimes(1);
  });
});

describe("owning worker: completeAttempt reports transitionApplied=true (control)", () => {
  it("on a 2xx success, fires onDelivered and resets endpoint health", async () => {
    const { store, calls } = fakeStore(true);
    const hooks = makeHooks();
    await deliverOne(registeredRow(), deps(store, ok, breakerOn, hooks));
    expect(hooks.onDelivered).toHaveBeenCalledTimes(1);
    expect(calls.success).toEqual([ENDPOINT_ID]);
  });

  it("on a retryable 5xx, fires onRetry and increments endpoint failure", async () => {
    const { store, calls } = fakeStore(true);
    const hooks = makeHooks();
    await deliverOne(registeredRow(), deps(store, fail500, breakerOn, hooks));
    expect(hooks.onRetry).toHaveBeenCalledTimes(1);
    expect(calls.failure).toEqual([ENDPOINT_ID]);
  });

  it("on a 410 Gone, fires onDead and disables the endpoint", async () => {
    const { store, calls } = fakeStore(true);
    const hooks = makeHooks();
    await deliverOne(registeredRow(), deps(store, gone410, breakerOn, hooks));
    expect(hooks.onDead).toHaveBeenCalledTimes(1);
    expect(calls.disabled).toEqual([ENDPOINT_ID]);
  });
});
