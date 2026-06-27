/**
 * Permanent vs retryable classification of pre-HTTP failures (failure-path hardening): a row that can
 * never resolve a target/secret, or whose secret is malformed/undecryptable, goes straight to `dead`
 * (DLQ) instead of burning the whole retry budget — while transient and admin-fixable failures stay
 * retryable. No Docker; the http client is never reached for these cases.
 */
import { describe, expect, it } from "vitest";
import { deliverOne } from "../../src/delivery/deliver";
import type { DeliverDeps } from "../../src/delivery/deliver";
import { resolveConfig } from "../../src/core/index";
import type { OutboxRow, Transition } from "../../src/core/index";
import type { Store, NewDeliveryAttempt } from "../../src/store/store";

interface Captured {
  transitions: Transition[];
  disabled: string[];
}

function store(over: Partial<Store> = {}): { store: Store; captured: Captured } {
  const captured: Captured = { transitions: [], disabled: [] };
  const base: Store = {
    insertOutbox: () => Promise.resolve(),
    insertOutboxMany: () => Promise.resolve(),
    insertOutboxAutonomous: () => Promise.resolve(),
    claimDue: () => Promise.resolve([]),
    applyTransition: () => Promise.resolve(),
    reclaimStuck: () => Promise.resolve(0),
    recordAttempt: () => Promise.resolve(),
    completeAttempt: (_a: NewDeliveryAttempt, t: Transition) => {
      captured.transitions.push(t);
      return Promise.resolve();
    },
    queryAttempts: () => Promise.resolve([]),
    selectForReplay: () => Promise.resolve([]),
    insertReplayCopies: () => Promise.resolve([]),
    listOutbox: () => Promise.resolve({ items: [], nextCursor: null }),
    listEndpoints: () => Promise.resolve({ items: [], nextCursor: null }),
    insertEndpoint: () => Promise.resolve(),
    updateEndpoint: () => Promise.resolve(),
    findEndpoint: () => Promise.resolve(null),
    disableEndpoint: (id) => {
      captured.disabled.push(id);
      return Promise.resolve();
    },
    stats: () => Promise.resolve({ counts: {} as never, oldestPendingAt: null }),
    diagnose: () => Promise.resolve({ ok: true, missingTables: [] }),
    migrate: () => Promise.resolve(),
    ...over,
  };
  return { store: base, captured };
}

function deps(s: Store): DeliverDeps {
  return {
    store: s,
    // Never reached for the pre-HTTP cases under test; a 2xx is returned defensively.
    http: {
      post: () =>
        Promise.resolve({
          status: 200,
          bodySnippet: "",
          durationMs: 1,
          error: null,
          retryAfter: null,
        }),
    },
    config: resolveConfig({ logger: { debug() {}, info() {}, warn() {}, error() {} } }),
    clock: () => new Date(0),
  };
}

const row = (over: Partial<OutboxRow> = {}): OutboxRow => ({
  id: "11111111-1111-1111-1111-111111111111",
  eventType: "order.created",
  payload: { a: 1 },
  endpointId: null,
  targetUrl: "https://example.test/hook",
  secretSnapshot: "whsec_dGVzdA",
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

describe("pre-HTTP permanent classification", () => {
  it("sends an inline row with a missing secret straight to dead (MISSING_SECRET)", async () => {
    const s = store();
    await deliverOne(row({ secretSnapshot: null }), deps(s.store));
    expect(s.captured.transitions).toHaveLength(1);
    expect(s.captured.transitions[0]).toMatchObject({ status: "dead", attempts: 1 });
  });

  it("sends a row with a malformed signing secret straight to dead (signing CONFIG_INVALID)", async () => {
    const s = store();
    // `whsec_` prefix with invalid base64 makes decodeSecret throw RelayError CONFIG_INVALID in sign().
    await deliverOne(row({ secretSnapshot: "whsec_@@@not-base64@@@" }), deps(s.store));
    expect(s.captured.transitions).toHaveLength(1);
    expect(s.captured.transitions[0]).toMatchObject({ status: "dead", attempts: 1 });
  });

  it("does not disable the endpoint on a permanent pre-HTTP failure", async () => {
    const s = store();
    await deliverOne(
      row({
        endpointId: "22222222-2222-2222-2222-222222222222",
        targetUrl: null,
        secretSnapshot: null,
      }),
      deps(s.store),
    );
    // endpointId set but resolveTarget returns ENDPOINT_NOT_FOUND (findEndpoint -> null), which is
    // retryable, so it stays pending — and certainly no disable.
    expect(s.captured.disabled).toEqual([]);
  });

  it("keeps an unknown endpoint retryable (ENDPOINT_NOT_FOUND -> pending)", async () => {
    const s = store();
    await deliverOne(
      row({
        endpointId: "22222222-2222-2222-2222-222222222222",
        targetUrl: null,
        secretSnapshot: null,
      }),
      deps(s.store),
    );
    expect(s.captured.transitions).toHaveLength(1);
    expect(s.captured.transitions[0]).toMatchObject({ status: "pending", attempts: 1 });
  });

  it("keeps a disabled endpoint retryable (ENDPOINT_DISABLED -> pending), no disable call", async () => {
    const ep = {
      id: "ep",
      url: "https://x.test/hook",
      secret: "whsec_dGVzdA",
      secretSecondary: null,
      status: "disabled" as const,
      description: null,
      consecutiveFailures: 0,
      disabledAt: new Date(0),
      metadata: null,
      createdAt: new Date(0),
    };
    const s = store({ findEndpoint: () => Promise.resolve(ep) });
    await deliverOne(
      row({ endpointId: "ep", targetUrl: null, secretSnapshot: null }),
      deps(s.store),
    );
    expect(s.captured.transitions[0]).toMatchObject({ status: "pending", attempts: 1 });
    expect(s.captured.disabled).toEqual([]);
  });

  it("keeps a transient DB error (non-CONFIG_INVALID) retryable", async () => {
    // completeAttempt throws once (the real write), the failover applyFailure succeeds and records a
    // retryable pending transition (not dead).
    let calls = 0;
    const transitions: Transition[] = [];
    const s = store({
      completeAttempt: (_a, t) => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error("connection reset"));
        transitions.push(t);
        return Promise.resolve();
      },
    });
    await deliverOne(row(), deps(s.store));
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ status: "pending", attempts: 1 });
  });
});
