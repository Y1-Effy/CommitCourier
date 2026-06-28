/**
 * deliverOne surfaces the two critical categories through DeliverDeps.critical: a security event (an
 * SSRF block, every attempt) and data loss (a row reaching `dead` = the DLQ). With no logger
 * configured these fall back to the console; with one configured they go to the logger only. Routine
 * retryable failures stay silent. No Docker; the store and http client are fakes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { deliverOne } from "../../src/delivery/deliver";
import type { DeliverDeps } from "../../src/delivery/deliver";
import { createCriticalLogger } from "../../src/delivery/critical";
import { resolveConfig } from "../../src/core/index";
import type { DeepPartial } from "../../src/core/config";
import type { Logger, OutboxRow, RelayConfig } from "../../src/core/index";
import type { Store, NewDeliveryAttempt } from "../../src/store/store";

type HttpResult = {
  status: number | null;
  bodySnippet: string;
  durationMs: number;
  error: string | null;
  retryAfter: string | null;
};

const noopLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function spyLogger(): Logger & { warns: number; errors: number } {
  const l = { warns: 0, errors: 0 } as Logger & { warns: number; errors: number };
  l.debug = () => {};
  l.info = () => {};
  l.warn = () => void (l.warns += 1);
  l.error = () => void (l.errors += 1);
  return l;
}

function store(): Store {
  const base: Store = {
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
    completeAttempt: (_a: NewDeliveryAttempt) => Promise.resolve({ transitionApplied: true }),
    queryAttempts: () => Promise.resolve([]),
    selectForReplay: () => Promise.resolve([]),
    insertReplayCopies: () => Promise.resolve([]),
    listOutbox: () => Promise.resolve({ items: [], nextCursor: null }),
    listEndpoints: () => Promise.resolve({ items: [], nextCursor: null }),
    insertEndpoint: () => Promise.resolve(),
    updateEndpoint: () => Promise.resolve(),
    findEndpoint: () => Promise.resolve(null),
    disableEndpoint: () => Promise.resolve(),
    stats: () => Promise.resolve({ counts: {} as never, oldestPendingAt: null }),
    diagnose: () => Promise.resolve({ ok: true, missingTables: [] }),
    migrate: () => Promise.resolve(),
  };
  return base;
}

function deps(
  s: Store,
  http: HttpResult,
  critical: DeliverDeps["critical"],
  cfg: DeepPartial<RelayConfig> = {},
): DeliverDeps {
  return {
    store: s,
    http: { post: () => Promise.resolve(http) },
    config: resolveConfig({ logger: noopLogger, ...cfg }),
    clock: () => new Date(0),
    critical,
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

const ok500: HttpResult = {
  status: 500,
  bodySnippet: "",
  durationMs: 1,
  error: null,
  retryAfter: null,
};
const ssrf: HttpResult = {
  status: null,
  bodySnippet: "",
  durationMs: 0,
  error: "SSRF_BLOCKED:metadata",
  retryAfter: null,
};
const gone: HttpResult = {
  status: 410,
  bodySnippet: "",
  durationMs: 1,
  error: null,
  retryAfter: null,
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deliverOne critical events with no logger configured (console fallback)", () => {
  it("logs a DLQ data-loss event to console.error when retries are exhausted", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const critical = createCriticalLogger(noopLogger, false);
    await deliverOne(row(), deps(store(), ok500, critical, { retry: { maxAttempts: 1 } }));
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]?.[1]).toMatchObject({ loggerConfigured: false, attempts: 1 });
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs an SSRF security event to console.warn on every attempt (retryable)", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const critical = createCriticalLogger(noopLogger, false);
    // maxAttempts high so the row stays pending (not dead): only the security event fires.
    await deliverOne(row(), deps(store(), ssrf, critical, { retry: { maxAttempts: 12 } }));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ reason: "metadata", loggerConfigured: false });
    expect(error).not.toHaveBeenCalled();
  });

  it("logs a DLQ data-loss event on a permanent (410 Gone) failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const critical = createCriticalLogger(noopLogger, false);
    await deliverOne(row(), deps(store(), gone, critical, { retry: { maxAttempts: 12 } }));
    expect(error).toHaveBeenCalledTimes(1);
  });

  it("stays silent for a routine retryable failure with attempts remaining", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const critical = createCriticalLogger(noopLogger, false);
    await deliverOne(row(), deps(store(), ok500, critical, { retry: { maxAttempts: 12 } }));
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("deliverOne critical events with a logger configured (no console)", () => {
  it("routes DLQ and SSRF to the logger, never the console", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const logger = spyLogger();

    const dlqCritical = createCriticalLogger(logger, true);
    await deliverOne(row(), deps(store(), ok500, dlqCritical, { retry: { maxAttempts: 1 } }));
    expect(logger.errors).toBe(1);

    const ssrfCritical = createCriticalLogger(logger, true);
    await deliverOne(row(), deps(store(), ssrf, ssrfCritical, { retry: { maxAttempts: 12 } }));
    expect(logger.warns).toBe(1);

    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
