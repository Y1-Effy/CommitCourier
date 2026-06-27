/**
 * Root public API (per 05-admin-api): `createRelay` and the `Relay<TTx>` it returns.
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
import { createDispatcher as makeDispatcher } from "./dispatcher/dispatcher";
import type { Dispatcher, DispatcherOptions } from "./dispatcher/dispatcher";
import {
  attempts as adminAttempts,
  replay as adminReplay,
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
   * See {@link createAesGcmCipher}. When omitted, secrets are stored as-is (plaintext).
   */
  cipher?: SecretCipher;
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
}

/** The public surface returned by {@link createRelay}. */
export interface Relay<TTx> {
  /** Ride the business TX (fail-closed). `trx` is required (basic design section 8.1). */
  enqueue(trx: TTx, input: EnqueueInput): Promise<{ id: string }>;
  /** Bulk enqueue inside the business TX (fail-closed): one round trip, returns ids in input order. */
  enqueueMany(trx: TTx, inputs: EnqueueInput[]): Promise<{ ids: string[] }>;
  /** Non-TX enqueue. Loses the atomicity guarantee; use only when there is no business TX. */
  enqueueUnsafe(input: EnqueueInput): Promise<{ id: string }>;
  /** Create a background dispatcher bound to this relay's store/deliver/config. */
  createDispatcher(options?: DispatcherOptions): Dispatcher;
  /** Read the delivery ledger for one outbox row. */
  attempts(opts: { outboxId: string }): Promise<DeliveryAttempt[]>;
  /** Replay matching rows as fresh pending copies; returns the new ids. */
  replay(opts: { outboxId: string } | { filter: ReplayFilter }): Promise<{ ids: string[] }>;
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
  let store = cipher ? createEncryptedStore(rawStore, cipher) : rawStore;
  if (endpointCacheTtlMs && endpointCacheTtlMs > 0) {
    store = createEndpointCache(store, { ttlMs: endpointCacheTtlMs });
  }
  return store;
}

export async function createRelay<TTx>(config: RelayInit<TTx>): Promise<Relay<TTx>> {
  const { store: rawStore, cipher, endpointCacheTtlMs, ...rest } = config;
  const store = wrapStore(rawStore, cipher, endpointCacheTtlMs);
  const resolved = resolveConfig(rest);

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
  const deliver = (row: OutboxRow): Promise<void> =>
    deliverOne(row, { store, http, config: resolved, clock: resolved.clock, hooks, instrument });

  /** Build the outbox row from enqueue input, snapshotting the inline secret at enqueue time. */
  function buildRow(input: EnqueueInput): NewOutboxRow {
    const init = initialState(resolved.mode, resolved.clock());
    const inline = asInline(input.endpoint);
    const registered = inline ? null : asRegistered(input.endpoint);
    if (!inline && !registered) {
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
      // Errors propagate so the user's TX rolls back with the business write (fail-closed).
      const row = buildRow(input);
      await store.insertOutbox(trx, row);
      return { id: row.id };
    },
    async enqueueMany(trx, inputs) {
      // One multi-row INSERT on the caller's TX; errors propagate (fail-closed).
      const rows = inputs.map(buildRow);
      await store.insertOutboxMany(trx, rows);
      return { ids: rows.map((r) => r.id) };
    },
    async enqueueUnsafe(input) {
      const row = buildRow(input);
      await store.insertOutboxAutonomous(row);
      return { id: row.id };
    },
    createDispatcher(options) {
      return makeDispatcher({ store, deliver, config: resolved, options });
    },
    attempts(opts) {
      return adminAttempts(store, opts.outboxId);
    },
    replay(opts) {
      return adminReplay(store, resolved.clock(), opts);
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

/** Compose the registered-endpoint admin surface over the store (05-admin-api section 7). */
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
