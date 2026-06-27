/**
 * Root public API: `createRelay` and the `Relay<TTx>` it returns.
 *
 * `createRelay` is the single entry point. It resolves/validates config, fails fast if the core
 * tables are missing, wires the HTTP client and bound `deliver`, and exposes enqueue (TX-riding,
 * fail-closed), dispatcher creation, ledger queries, replay, and endpoint disabling. The store's
 * generic flows through so `enqueue`'s `trx` type is the driver's transaction handle.
 */
import { newId } from "./id";
import { resolveConfig, initialState, RelayError } from "./core/index";
import type {
  EnqueueInput,
  OutboxRow,
  DeliveryAttempt,
  EndpointRow,
  Mode,
  SigningConfig,
  RetryConfig,
  DeliveryConfig,
  SsrfConfig,
  CircuitBreakerConfig,
  SecretCipher,
  Clock,
  Logger,
} from "./core/index";
import type {
  Store,
  NewOutboxRow,
  ReplayFilter,
  EndpointPatch,
  OutboxStats,
  OutboxListFilter,
  OutboxListItem,
  EndpointListFilter,
  EndpointSummary,
  Page,
} from "./store/store";
import { createEncryptedStore } from "./store/encrypted-store";
import { createEndpointCache } from "./store/endpoint-cache";
import { createHttpClient } from "./delivery/http";
import { deliverOne } from "./delivery/deliver";
import type { DeliveryHooks, DeliveryInstrument } from "./delivery/deliver";
import { createCriticalLogger } from "./delivery/critical";
import { createDispatcher as makeDispatcher } from "./dispatcher/dispatcher";
import type { Dispatcher, DispatcherOptions, RunOnceOptions } from "./dispatcher/dispatcher";
import type { Accelerator } from "./accelerator/accelerator";
import type { Sink } from "./forward/index";
import {
  attempts as adminAttempts,
  replay as adminReplay,
  prune as adminPrune,
  cancel as adminCancel,
  getOutbox as adminGetOutbox,
  listOutbox as adminListOutbox,
  listEndpoints as adminListEndpoints,
  registerEndpoint as adminRegister,
  updateEndpoint as adminUpdate,
  enableEndpoint as adminEnable,
  getEndpoint as adminGet,
  disableEndpoint as adminDisable,
  rotateEndpointSecret as adminRotate,
  finalizeRotation as adminFinalizeRotation,
} from "./admin/admin";
import type { PruneOptions } from "./admin/admin";

/** Input to {@link EndpointAdmin.register}. */
export interface RegisterEndpointInput {
  url: string;
  secret: string;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** The registered-endpoint admin surface exposed by {@link Relay.endpoints}. */
export interface EndpointAdmin {
  /** Register a new endpoint; returns the generated id. */
  register(input: RegisterEndpointInput): Promise<{ id: string }>;
  /** Patch a registered endpoint; only the provided fields change. */
  update(endpointId: string, patch: EndpointPatch): Promise<void>;
  /** Re-enable a disabled endpoint. */
  enable(endpointId: string): Promise<void>;
  /** Disable an endpoint so no further deliveries target it. */
  disable(endpointId: string): Promise<void>;
  /** Look up a registered endpoint, or null when absent. */
  get(endpointId: string): Promise<EndpointRow | null>;
  /**
   * List registered endpoints (read-only, secret-free). Ordered by id; pass the returned
   * `nextCursor` for the next page (null when the last page was returned).
   */
  list(filter?: EndpointListFilter): Promise<Page<EndpointSummary>>;
  /**
   * Begin a signing-key rotation: promote the current secret to the secondary slot and set
   * `newSecret` as primary, so deliveries are dual-signed with both keys. Call
   * {@link EndpointAdmin.finalizeRotation} once receivers have migrated to drop the old key.
   */
  rotateSecret(endpointId: string, newSecret: string): Promise<void>;
  /** Finish a rotation: drop the secondary secret so deliveries sign with the new key only. */
  finalizeRotation(endpointId: string): Promise<void>;
}

/** Arguments to {@link createRelay}: the store plus a partial relay configuration. */
export interface RelayInit<TTx> {
  store: Store<TTx>;
  /**
   * Optional cipher for encrypting signing secrets at rest (`secretSnapshot`, endpoint `secret`).
   * When provided, the store is transparently wrapped so secrets are ciphertext in the backend.
   * See {@link createAesGcmCipher}. When omitted, secrets are stored as-is (plaintext), so at-rest
   * encryption becomes the database's responsibility — `createRelay` warns about this at startup
   * unless you acknowledge it with {@link RelayInit.unsafeAllowPlaintextSecrets}.
   */
  cipher?: SecretCipher;
  /**
   * Acknowledge that signing secrets are intentionally stored in plaintext (no `cipher`) because
   * at-rest encryption is handled elsewhere (DB disk encryption, column encryption, etc.). Silences
   * the startup plaintext-secret warning. Has no effect when `cipher` is set. Default false.
   */
  unsafeAllowPlaintextSecrets?: boolean;
  /**
   * Optional TTL (ms) for an in-process registered-endpoint lookup cache. Cuts the per-delivery
   * `findEndpoint` DB round trip on the registered-endpoint hot path; `updateEndpoint`/`disable`
   * evict in-process, and the TTL bounds cross-process staleness. Omitted/0 disables caching
   * (default). Has no effect on the inline `{ url, secret }` workflow.
   */
  endpointCacheTtlMs?: number;
  mode?: Mode;
  signing?: Partial<SigningConfig>;
  retry?: Partial<RetryConfig>;
  delivery?: Partial<DeliveryConfig>;
  ssrf?: Partial<SsrfConfig>;
  /**
   * Registered-endpoint circuit breaker: after `failureThreshold` consecutive failed deliveries an
   * endpoint is auto-disabled (a success resets the count). Default `{ failureThreshold: 0 }` = off.
   */
  circuitBreaker?: Partial<CircuitBreakerConfig>;
  clock?: Clock;
  logger?: Logger;
  /** Optional delivery-outcome callbacks (fail-open) applied to every dispatcher from this relay. */
  hooks?: DeliveryHooks;
  /**
   * Optional, fail-open tracing/metrics seam applied to every delivery from this relay (the
   * OpenTelemetry seam). See {@link DeliveryInstrument}; wire it with `createOtelInstrumentation`
   * from `commitcourier/otel`.
   */
  instrument?: DeliveryInstrument;
  /**
   * Optional low-latency wake accelerator (fail-open). When provided, each enqueue signals it (so a
   * listening dispatcher wakes at once instead of after the poll interval) and every dispatcher this
   * relay creates subscribes to it. The outbox row stays the source of truth, so a missed wake only
   * delays delivery. Wire it with `createPgAccelerator` from `commitcourier/accelerator/pg`.
   */
  accelerator?: Accelerator<TTx>;
  /**
   * Delivery sink for `sink` transport. Required when
   * `delivery.transport === "sink"` — each event is handed to it instead of being delivered over HTTP,
   * and CommitCourier's signing/SSRF/circuit breaker are delegated. Ignored for the default `http`
   * transport. Each handoff is bounded by `delivery.timeoutMs`, but the sink is also responsible for
   * its own latency/timeout. Wire it with `svixSink` from `commitcourier/forward/svix` or your own `Sink`.
   */
  sink?: Sink;
}

/** The public surface returned by {@link createRelay}. */
export interface Relay<TTx> {
  /** Ride the business TX (fail-closed). `trx` is required. */
  enqueue(trx: TTx, input: EnqueueInput): Promise<{ id: string }>;
  /** Bulk enqueue inside the business TX (fail-closed): one round trip, returns ids in input order. */
  enqueueMany(trx: TTx, inputs: EnqueueInput[]): Promise<{ ids: string[] }>;
  /** Non-TX enqueue. Loses the atomicity guarantee; use only when there is no business TX. */
  enqueueUnsafe(input: EnqueueInput): Promise<{ id: string }>;
  /** Create a background dispatcher bound to this relay's store/deliver/config. */
  createDispatcher(options?: DispatcherOptions): Dispatcher;
  /**
   * Drain the queue once and return (no long-lived loop), for serverless/cron deployments. A
   * one-shot convenience over `createDispatcher(options).runOnce(runOptions)`; it never subscribes
   * the accelerator (the loop's wake seam is irrelevant to a single drain). Returns the number of
   * rows dispatched this run.
   */
  dispatchOnce(
    options?: DispatcherOptions,
    runOptions?: RunOnceOptions,
  ): Promise<{ processed: number }>;
  /** Read the delivery ledger for one outbox row. */
  attempts(opts: { outboxId: string }): Promise<DeliveryAttempt[]>;
  /**
   * Replay matching rows as fresh pending copies; returns the new ids and `capped` (true when the
   * selection hit the safety limit, so not everything matched was replayed). To replay more, narrow
   * the filter or raise `filter.limit` — re-calling with the same filter re-sends the same rows
   * (replay does not change the source rows), so do not loop on `capped`. The limit is always clamped.
   */
  replay(
    opts: { outboxId: string } | { filter: ReplayFilter },
  ): Promise<{ ids: string[]; capped: boolean }>;
  /** Cancel a not-yet-sent row (`pending` -&gt; `cancelled`); `cancelled` is false when it was too late. */
  cancel(outboxId: string): Promise<{ cancelled: boolean }>;
  /**
   * Retention: delete terminal rows older than `olderThan` in a bounded batch (ledger attempts
   * cascade). Only non-active statuses are eligible (default `delivered`/`dead`/`cancelled`); a
   * `pending`/`in_flight` row is never deleted. Returns `{ deleted }` — when it equals the (clamped)
   * limit, more may remain, so call again to keep pruning.
   */
  prune(opts: PruneOptions): Promise<{ deleted: number }>;
  /** Fetch one outbox row by id (read-only, secret-free), or null when unknown. */
  get(outboxId: string): Promise<OutboxListItem | null>;
  /**
   * List outbox rows (read-only, secret-free) for DLQ inspection/monitoring; newest-first by `seq`.
   * Pass `{ status: "dead" }` to inspect the DLQ; page with the returned `nextCursor`.
   */
  list(filter?: OutboxListFilter): Promise<Page<OutboxListItem>>;
  /** Registered-endpoint admin: register / update / enable / disable / get / list. */
  endpoints: EndpointAdmin;
  /** Aggregate queue statistics (status counts and oldest-pending age) for monitoring. */
  stats(): Promise<OutboxStats>;
}

type InlineEndpoint = { url: string; secret: string };

// `ep` is typed but may be anything at runtime (JS callers can omit `endpoint`), so guard that it
// is a non-null object before using the `in` operator, which would otherwise throw a TypeError
// instead of the intended ENQUEUE_NO_TARGET.
function asInline(ep: unknown): InlineEndpoint | null {
  return typeof ep === "object" &&
    ep !== null &&
    "url" in ep &&
    "secret" in ep &&
    typeof ep.url === "string" &&
    typeof ep.secret === "string"
    ? { url: ep.url, secret: ep.secret }
    : null;
}

function asRegistered(ep: unknown): { endpointId: string } | null {
  return typeof ep === "object" &&
    ep !== null &&
    "endpointId" in ep &&
    typeof ep.endpointId === "string"
    ? { endpointId: ep.endpointId }
    : null;
}

/**
 * Compose the store decorators: encrypt secrets at rest, then (optionally) cache decrypted endpoint
 * lookups outermost so every layer below keeps seeing plaintext rows. Validates the cache TTL.
 */
function wrapStore<TTx>(
  rawStore: Store<TTx>,
  cipher: SecretCipher | undefined,
  endpointCacheTtlMs: number | undefined,
  logger: Logger,
): Store<TTx> {
  if (
    endpointCacheTtlMs !== undefined &&
    !(Number.isFinite(endpointCacheTtlMs) && endpointCacheTtlMs >= 0)
  ) {
    throw new RelayError(
      "CONFIG_INVALID",
      `endpointCacheTtlMs must be a number >= 0, got ${String(endpointCacheTtlMs)}`,
    );
  }
  // The encrypted store logs (and quarantines) undecryptable rows, so it needs the relay's logger.
  let store = cipher ? createEncryptedStore(rawStore, cipher, logger) : rawStore;
  if (endpointCacheTtlMs && endpointCacheTtlMs > 0) {
    store = createEndpointCache(store, { ttlMs: endpointCacheTtlMs });
  }
  return store;
}

export async function createRelay<TTx>(config: RelayInit<TTx>): Promise<Relay<TTx>> {
  const {
    store: rawStore,
    cipher,
    endpointCacheTtlMs,
    unsafeAllowPlaintextSecrets,
    sink,
    ...rest
  } = config;
  // Delivery is fail-open, so without a logger routine failures/retries are swallowed silently. The
  // two critical categories — security (SSRF blocks) and data loss (DLQ transitions) — fall back to
  // the console even with no logger (see createCriticalLogger), but everything else stays silent, so
  // warn once at startup; pass `logger` (e.g. `createConsoleLogger()`) to capture all operational logs.
  const loggerConfigured = config.logger !== undefined;
  if (!loggerConfigured) {
    console.warn(
      "[commitcourier] no logger configured: routine delivery failures and retries will be silent. " +
        "Security events (SSRF blocks) and data loss (DLQ transitions) will fall back to console. " +
        "Pass `logger` (e.g. createConsoleLogger() from commitcourier/core) to capture all operational logs.",
    );
  }
  // Resolve config first so the store decorators (encrypted store) can use the resolved logger.
  const resolved = resolveConfig(rest);
  // Signing secrets are written in plaintext without a cipher. This is a security footgun, so warn at
  // startup unless the caller acknowledges that at-rest encryption is handled elsewhere — symmetric to
  // the no-logger warning above. Non-fatal: never breaks an existing deployment. Skipped in `sink`
  // transport, where signing is delegated and no signing secret is used (the warning would be noise).
  if (
    cipher === undefined &&
    unsafeAllowPlaintextSecrets !== true &&
    resolved.delivery.transport !== "sink"
  ) {
    const msg =
      "no cipher configured: signing secrets (secret_snapshot, endpoint secret) are stored in PLAINTEXT " +
      "in your database. At-rest encryption is then a precondition you must meet elsewhere (DB disk " +
      "encryption, column encryption, or pass `cipher` e.g. createAesGcmCipher). Set " +
      "`unsafeAllowPlaintextSecrets: true` to acknowledge and silence this.";
    if (loggerConfigured) resolved.logger.warn(msg);
    else console.warn(`[commitcourier] ${msg}`);
  }
  // In `sink` transport the destination is delegated to the sink/SaaS: `sink` is required, and CC-side
  // signing/SSRF/circuit-breaker settings do not apply. Fail fast on a missing sink; warn once that the
  // delegated settings are ignored (non-fatal — they are naturally left over during a staged migration).
  if (resolved.delivery.transport === "sink") {
    if (sink === undefined) {
      throw new RelayError("CONFIG_INVALID", 'delivery.transport "sink" requires a sink');
    }
    const msg =
      'delivery.transport is "sink": CommitCourier delegates signing, SSRF protection and the circuit ' +
      "breaker to the sink/SaaS, so any signing/ssrf/circuitBreaker settings are ignored. The sink is " +
      "responsible for final delivery and customer-facing retries.";
    if (loggerConfigured) resolved.logger.warn(msg);
    else console.warn(`[commitcourier] ${msg}`);
  }
  const store = wrapStore(rawStore, cipher, endpointCacheTtlMs, resolved.logger);

  const diag = await store.diagnose();
  if (!diag.ok) {
    throw new RelayError(
      "MISSING_TABLES",
      `required tables missing: ${diag.missingTables.join(", ")}`,
    );
  }

  const http = createHttpClient({ ssrf: resolved.ssrf, delivery: resolved.delivery });
  const hooks = config.hooks;
  const instrument = config.instrument;
  const accelerator = config.accelerator;
  // Surfaces security/data-loss events to the console when no logger was configured; otherwise routes
  // to the configured logger only (see createCriticalLogger).
  const critical = createCriticalLogger(resolved.logger, loggerConfigured);
  const deliver = (row: OutboxRow): Promise<void> =>
    deliverOne(row, {
      store,
      http,
      config: resolved,
      clock: resolved.clock,
      critical,
      hooks,
      instrument,
      sink,
    });

  /** Build the outbox row from enqueue input, snapshotting the inline secret at enqueue time. */
  function buildRow(input: EnqueueInput): NewOutboxRow {
    const init = initialState(resolved.mode, resolved.clock());
    const inline = asInline(input.endpoint);
    const registered = inline ? null : asRegistered(input.endpoint);
    // `sink` transport delivers to the configured sink/SaaS, not a per-event URL, so a target is not
    // required (the row is target-less). `http` still requires one.
    if (!inline && !registered && resolved.delivery.transport !== "sink") {
      throw new RelayError(
        "ENQUEUE_NO_TARGET",
        "enqueue requires endpoint { url, secret } or { endpointId }",
      );
    }
    return {
      id: newId(),
      eventType: input.eventType,
      payload: input.payload,
      endpointId: registered ? registered.endpointId : null,
      targetUrl: inline ? inline.url : null,
      secretSnapshot: inline ? inline.secret : null,
      status: init.status,
      attempts: init.attempts,
      availableAt: init.availableAt,
      idempotencyKey: input.idempotencyKey ?? null,
    };
  }

  return {
    async enqueue(trx, input) {
      // Errors propagate so the user's TX rolls back with the business write (fail-closed). The
      // accelerator wake rides the same TX (NOTIFY on COMMIT), so a freshly enqueued row wakes a
      // listening dispatcher at once; its failure consistently rolls back with the enqueue.
      const row = buildRow(input);
      await store.insertOutbox(trx, row);
      if (accelerator) await accelerator.signal(trx);
      return { id: row.id };
    },
    async enqueueMany(trx, inputs) {
      // One multi-row INSERT on the caller's TX; errors propagate (fail-closed). A single wake
      // suffices for the whole batch.
      const rows = inputs.map(buildRow);
      await store.insertOutboxMany(trx, rows);
      if (rows.length > 0 && accelerator) await accelerator.signal(trx);
      return { ids: rows.map((r) => r.id) };
    },
    async enqueueUnsafe(input) {
      const row = buildRow(input);
      await store.insertOutboxAutonomous(row);
      // Best-effort wake outside any TX; never let a signal failure break the (already non-atomic)
      // enqueueUnsafe — the poller is the safety net.
      if (accelerator) {
        try {
          await accelerator.signalAutonomous();
        } catch (err) {
          resolved.logger.warn("accelerator signalAutonomous failed", { error: String(err) });
        }
      }
      return { id: row.id };
    },
    createDispatcher(options) {
      return makeDispatcher({
        store,
        deliver,
        config: resolved,
        options,
        wakeSignal: accelerator ? (onWake) => accelerator.subscribe(onWake) : undefined,
      });
    },
    dispatchOnce(options, runOptions) {
      // No wakeSignal: runOnce never subscribes, so the accelerator seam is irrelevant to one drain.
      return makeDispatcher({ store, deliver, config: resolved, options }).runOnce(runOptions);
    },
    attempts(opts) {
      return adminAttempts(store, opts.outboxId);
    },
    async replay(opts) {
      const result = await adminReplay(store, resolved.clock(), opts);
      // Replayed rows are fresh `pending` copies; wake a listening dispatcher just like enqueue so
      // they are delivered without waiting for the next idle poll. Best-effort (the poller is the
      // net), so a signal failure never fails the replay.
      if (result.ids.length > 0 && accelerator) {
        try {
          await accelerator.signalAutonomous();
        } catch (err) {
          resolved.logger.warn("accelerator signal after replay failed", { error: String(err) });
        }
      }
      return result;
    },
    cancel(outboxId) {
      return adminCancel(store, outboxId);
    },
    prune(opts) {
      return adminPrune(store, opts);
    },
    get(outboxId) {
      return adminGetOutbox(store, outboxId);
    },
    list(filter) {
      return adminListOutbox(store, filter);
    },
    endpoints: endpointAdmin(store, resolved.clock),
    stats() {
      return store.stats();
    },
  };
}

/** Compose the registered-endpoint admin surface over the store. */
function endpointAdmin(store: Store, clock: Clock): EndpointAdmin {
  return {
    register: (input) => adminRegister(store, input),
    update: (id, patch) => adminUpdate(store, id, patch),
    enable: (id) => adminEnable(store, id),
    disable: (id) => adminDisable(store, id, clock()),
    get: (id) => adminGet(store, id),
    list: (filter) => adminListEndpoints(store, filter),
    rotateSecret: (id, newSecret) => adminRotate(store, id, newSecret),
    finalizeRotation: (id) => adminFinalizeRotation(store, id),
  };
}
