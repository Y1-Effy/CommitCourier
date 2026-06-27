/**
 * Circuit-breaker wiring on the delivery path (v2.1): a real HTTP outcome to a registered endpoint
 * records endpoint health (reset on success, increment+auto-disable on failure) via the store; the
 * store owns the threshold logic. Off by default (failureThreshold 0), never fires for inline
 * destinations, skips the 410 path (already disabled), and is fail-open. No Docker (the http client
 * and store are faked).
 */
import { describe, expect, it, vi } from "vitest";
import { deliverOne } from "../../src/delivery/deliver";
import type { DeliverDeps } from "../../src/delivery/deliver";
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
  success: string[];
  failure: { id: string; threshold: number }[];
}

function fakeStore(): { store: Store; calls: Calls } {
  const calls: Calls = { success: [], failure: [] };
  const store = {
    findEndpoint: () => Promise.resolve(endpoint()),
    completeAttempt: () => Promise.resolve(),
    disableEndpoint: () => Promise.resolve(),
    noteEndpointSuccess: (id: string) => Promise.resolve(void calls.success.push(id)),
    noteEndpointFailure: (id: string, _now: Date, threshold: number) =>
      Promise.resolve(void calls.failure.push({ id, threshold })),
  } as unknown as Store;
  return { store, calls };
}

function deps(store: Store, result: HttpResult, config: RelayConfig): DeliverDeps {
  return { store, http: { post: () => Promise.resolve(result) }, config, clock: () => new Date(0) };
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
const breakerOff = resolveConfig({});

describe("circuit breaker on the delivery path", () => {
  it("resets endpoint health on a 2xx delivery", async () => {
    const { store, calls } = fakeStore();
    await deliverOne(registeredRow(), deps(store, ok, breakerOn));
    expect(calls.success).toEqual([ENDPOINT_ID]);
    expect(calls.failure).toHaveLength(0);
  });

  it("records a failure (with the configured threshold) on a retryable 5xx", async () => {
    const { store, calls } = fakeStore();
    await deliverOne(registeredRow(), deps(store, fail500, breakerOn));
    expect(calls.failure).toEqual([{ id: ENDPOINT_ID, threshold: 3 }]);
    expect(calls.success).toHaveLength(0);
  });

  it("does nothing when the feature is off (failureThreshold 0)", async () => {
    const { store, calls } = fakeStore();
    await deliverOne(registeredRow(), deps(store, fail500, breakerOff));
    expect(calls.failure).toHaveLength(0);
    expect(calls.success).toHaveLength(0);
  });

  it("does not double-count a 410 (already disabled by the permanent-failure path)", async () => {
    const { store, calls } = fakeStore();
    await deliverOne(registeredRow(), deps(store, gone410, breakerOn));
    expect(calls.failure).toHaveLength(0);
    expect(calls.success).toHaveLength(0);
  });

  it("never fires for an inline destination (no endpoint to disable)", async () => {
    const { store, calls } = fakeStore();
    const inline: OutboxRow = {
      ...registeredRow(),
      endpointId: null,
      targetUrl: "https://example.test/hook",
      secretSnapshot: "whsec_dGVzdA",
    };
    await deliverOne(inline, deps(store, fail500, breakerOn));
    expect(calls.failure).toHaveLength(0);
    expect(calls.success).toHaveLength(0);
  });

  it("is fail-open: a health-update error never breaks the delivery", async () => {
    const error = vi.fn();
    const store = {
      findEndpoint: () => Promise.resolve(endpoint()),
      completeAttempt: () => Promise.resolve(),
      noteEndpointSuccess: () => Promise.reject(new Error("db down")),
      noteEndpointFailure: () => Promise.reject(new Error("db down")),
    } as unknown as Store;
    const config = resolveConfig({
      circuitBreaker: { failureThreshold: 2 },
      logger: { debug() {}, info() {}, warn() {}, error },
    });
    // Should not throw even though the health update rejects.
    await expect(deliverOne(registeredRow(), deps(store, ok, config))).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
  });
});
