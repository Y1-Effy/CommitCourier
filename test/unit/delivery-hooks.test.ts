/**
 * Delivery-hook fan-out (DX): deliverOne fires exactly one of onDelivered/onRetry/onDead per
 * attempt, and a throwing hook is swallowed (fail-open) without breaking the delivery. No Docker.
 */
import { describe, expect, it, vi } from "vitest";
import { deliverOne } from "../../src/delivery/deliver";
import type { DeliverDeps, DeliveryHooks } from "../../src/delivery/deliver";
import { resolveConfig } from "../../src/core/index";
import type { OutboxRow } from "../../src/core/index";
import type { Store } from "../../src/store/store";

type HttpResult = Awaited<ReturnType<DeliverDeps["http"]["post"]>>;

const noopStore = (over: Partial<Store> = {}): Store => ({
  insertOutbox: () => Promise.resolve(),
  insertOutboxMany: () => Promise.resolve(),
  insertOutboxAutonomous: () => Promise.resolve(),
  claimDue: () => Promise.resolve([]),
  applyTransition: () => Promise.resolve(),
  reclaimStuck: () => Promise.resolve(0),
  recordAttempt: () => Promise.resolve(),
  completeAttempt: () => Promise.resolve(),
  queryAttempts: () => Promise.resolve([]),
  selectForReplay: () => Promise.resolve([]),
  insertReplayCopies: () => Promise.resolve([]),
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
  targetUrl: "https://example.test/hook",
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
  hooks: DeliveryHooks;
  maxAttempts?: number;
  onError?: () => void;
}): DeliverDeps {
  const config = resolveConfig({
    retry: opts.maxAttempts != null ? { maxAttempts: opts.maxAttempts } : {},
    logger: { debug() {}, info() {}, warn() {}, error: opts.onError ?? (() => {}) },
  });
  return {
    store: noopStore(),
    http: { post: () => Promise.resolve(opts.result) },
    config,
    clock: () => new Date(0),
    hooks: opts.hooks,
  };
}

const ok: HttpResult = { status: 200, bodySnippet: "ok", durationMs: 7, error: null };
const fail: HttpResult = { status: 500, bodySnippet: "err", durationMs: 9, error: null };

describe("delivery hooks", () => {
  it("fires onDelivered (only) on a 2xx response", async () => {
    const hooks = { onDelivered: vi.fn(), onRetry: vi.fn(), onDead: vi.fn() };
    await deliverOne(row(), deps({ result: ok, hooks }));
    expect(hooks.onDelivered).toHaveBeenCalledTimes(1);
    expect(hooks.onRetry).not.toHaveBeenCalled();
    expect(hooks.onDead).not.toHaveBeenCalled();
    expect(hooks.onDelivered.mock.calls[0]?.[0]).toMatchObject({
      id: row().id,
      eventType: "order.created",
      attempt: 1,
      status: 200,
      error: null,
      durationMs: 7,
    });
  });

  it("fires onRetry when the attempt fails but attempts remain", async () => {
    const hooks = { onDelivered: vi.fn(), onRetry: vi.fn(), onDead: vi.fn() };
    await deliverOne(row(), deps({ result: fail, hooks, maxAttempts: 12 }));
    expect(hooks.onRetry).toHaveBeenCalledTimes(1);
    expect(hooks.onDelivered).not.toHaveBeenCalled();
    expect(hooks.onDead).not.toHaveBeenCalled();
    expect(hooks.onRetry.mock.calls[0]?.[0]).toMatchObject({ status: 500, error: "HTTP 500" });
  });

  it("fires onDead when the failed attempt exhausts maxAttempts", async () => {
    const hooks = { onDelivered: vi.fn(), onRetry: vi.fn(), onDead: vi.fn() };
    await deliverOne(row(), deps({ result: fail, hooks, maxAttempts: 1 }));
    expect(hooks.onDead).toHaveBeenCalledTimes(1);
    expect(hooks.onRetry).not.toHaveBeenCalled();
  });

  it("persists via a single completeAttempt (one DB round trip), not record+transition", async () => {
    const calls = { complete: 0, record: 0, transition: 0 };
    const store = noopStore({
      completeAttempt: () => {
        calls.complete++;
        return Promise.resolve();
      },
      recordAttempt: () => {
        calls.record++;
        return Promise.resolve();
      },
      applyTransition: () => {
        calls.transition++;
        return Promise.resolve();
      },
    });
    const config = resolveConfig({});
    await deliverOne(row(), {
      store,
      http: { post: () => Promise.resolve(ok) },
      config,
      clock: () => new Date(0),
    });
    expect(calls.complete).toBe(1);
    expect(calls.record).toBe(0);
    expect(calls.transition).toBe(0);
  });

  it("swallows a throwing hook (fail-open) and logs it", async () => {
    const onError = vi.fn();
    const hooks = {
      onDelivered: () => {
        throw new Error("hook boom");
      },
    };
    await expect(deliverOne(row(), deps({ result: ok, hooks, onError }))).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });
});
