/**
 * Circuit-breaker auto-recovery (half-open) on the delivery path: once a registered endpoint has been
 * disabled for at least `cooldownMs`, a single delivery is let through as a trial. Success re-activates
 * the endpoint (`reactivateEndpoint`); failure re-arms the cooldown (`disableEndpoint`); within the
 * cooldown no HTTP attempt is made at all. Off by default (`cooldownMs: 0`). No Docker (http + store
 * are faked).
 */
import { describe, expect, it } from "vitest";
import { deliverOne } from "../../src/delivery/deliver";
import type { DeliverDeps } from "../../src/delivery/deliver";
import { resolveConfig } from "../../src/core/index";
import type { OutboxRow, EndpointRow, RelayConfig } from "../../src/core/index";
import type { Store } from "../../src/store/store";

type HttpResult = Awaited<ReturnType<DeliverDeps["http"]["post"]>>;

const ENDPOINT_ID = "22222222-2222-2222-2222-222222222222";
const DISABLED_AT = new Date(1_000_000);

function disabledEndpoint(over: Partial<EndpointRow> = {}): EndpointRow {
  return {
    id: ENDPOINT_ID,
    url: "https://example.test/hook",
    secret: "whsec_dGVzdA",
    secretSecondary: null,
    status: "disabled",
    description: null,
    consecutiveFailures: 3,
    disabledAt: DISABLED_AT,
    metadata: null,
    createdAt: new Date(0),
    ...over,
  };
}

interface Calls {
  reactivate: string[];
  disable: string[];
  posts: number;
}

function fakeStore(ep: EndpointRow): { store: Store; calls: Calls } {
  const calls: Calls = { reactivate: [], disable: [], posts: 0 };
  const store = {
    findEndpoint: () => Promise.resolve(ep),
    completeAttempt: () => Promise.resolve(),
    reactivateEndpoint: (id: string) => Promise.resolve(void calls.reactivate.push(id)),
    disableEndpoint: (id: string) => Promise.resolve(void calls.disable.push(id)),
    noteEndpointSuccess: () => Promise.resolve(),
    noteEndpointFailure: () => Promise.resolve(),
  } as unknown as Store;
  return { store, calls };
}

function deps(opts: {
  store: Store;
  result: HttpResult;
  config: RelayConfig;
  now: Date;
  calls: Calls;
}): DeliverDeps {
  return {
    store: opts.store,
    http: {
      post: () => {
        opts.calls.posts++;
        return Promise.resolve(opts.result);
      },
    },
    config: opts.config,
    clock: () => opts.now,
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

const row = (): OutboxRow => ({
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

const COOLDOWN = 60_000;
const config = (cooldownMs: number): RelayConfig =>
  resolveConfig({
    circuitBreaker: { failureThreshold: 3, cooldownMs },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });

const pastCooldown = new Date(DISABLED_AT.getTime() + COOLDOWN + 1);
const withinCooldown = new Date(DISABLED_AT.getTime() + COOLDOWN - 1);

describe("circuit-breaker half-open auto-recovery", () => {
  it("lets a trial through past the cooldown and re-activates on a 2xx", async () => {
    const { store, calls } = fakeStore(disabledEndpoint());
    await deliverOne(
      row(),
      deps({ store, result: ok, config: config(COOLDOWN), now: pastCooldown, calls }),
    );
    expect(calls.posts).toBe(1);
    expect(calls.reactivate).toEqual([ENDPOINT_ID]);
    expect(calls.disable).toHaveLength(0);
  });

  it("re-arms the cooldown (keeps it disabled) when the trial fails", async () => {
    const { store, calls } = fakeStore(disabledEndpoint());
    await deliverOne(
      row(),
      deps({ store, result: fail500, config: config(COOLDOWN), now: pastCooldown, calls }),
    );
    expect(calls.posts).toBe(1);
    expect(calls.disable).toEqual([ENDPOINT_ID]);
    expect(calls.reactivate).toHaveLength(0);
  });

  it("makes no HTTP attempt while still within the cooldown", async () => {
    const { store, calls } = fakeStore(disabledEndpoint());
    await deliverOne(
      row(),
      deps({ store, result: ok, config: config(COOLDOWN), now: withinCooldown, calls }),
    );
    expect(calls.posts).toBe(0);
    expect(calls.reactivate).toHaveLength(0);
    expect(calls.disable).toHaveLength(0);
  });

  it("never trials when auto-recovery is off (cooldownMs 0), even long after disabling", async () => {
    const { store, calls } = fakeStore(disabledEndpoint());
    const farFuture = new Date(DISABLED_AT.getTime() + 10 * COOLDOWN);
    await deliverOne(row(), deps({ store, result: ok, config: config(0), now: farFuture, calls }));
    expect(calls.posts).toBe(0);
    expect(calls.reactivate).toHaveLength(0);
  });

  it("does not trial a disabled endpoint that has no disabled_at timestamp", async () => {
    const { store, calls } = fakeStore(disabledEndpoint({ disabledAt: null }));
    await deliverOne(
      row(),
      deps({ store, result: ok, config: config(COOLDOWN), now: pastCooldown, calls }),
    );
    expect(calls.posts).toBe(0);
    expect(calls.reactivate).toHaveLength(0);
  });
});
