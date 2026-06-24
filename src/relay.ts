/**
 * Root public API (per 05-admin-api): `createRelay` and the `Relay<TTx>` it returns.
 *
 * `createRelay` is the single entry point. It resolves/validates config, fails fast if the core
 * tables are missing, wires the HTTP client and bound `deliver`, and exposes enqueue (TX-riding,
 * fail-closed), dispatcher creation, ledger queries, replay, and endpoint disabling. The store's
 * generic flows through so `enqueue`'s `trx` type is the driver's transaction handle.
 */
import { randomUUID } from "node:crypto";
import { resolveConfig, initialState, RelayError } from "./core/index";
import type {
  EnqueueInput,
  OutboxRow,
  DeliveryAttempt,
  Mode,
  SigningConfig,
  RetryConfig,
  DeliveryConfig,
  SsrfConfig,
  Clock,
  Logger,
} from "./core/index";
import type { Store, NewOutboxRow, ReplayFilter } from "./store/store";
import { createHttpClient } from "./delivery/http";
import { deliverOne } from "./delivery/deliver";
import { createDispatcher as makeDispatcher } from "./dispatcher/dispatcher";
import type { Dispatcher, DispatcherOptions } from "./dispatcher/dispatcher";
import {
  attempts as adminAttempts,
  replay as adminReplay,
  disableEndpoint as adminDisable,
} from "./admin/admin";

/** Arguments to {@link createRelay}: the store plus a partial relay configuration. */
export interface RelayInit<TTx> {
  store: Store<TTx>;
  mode?: Mode;
  signing?: Partial<SigningConfig>;
  retry?: Partial<RetryConfig>;
  delivery?: Partial<DeliveryConfig>;
  ssrf?: Partial<SsrfConfig>;
  clock?: Clock;
  logger?: Logger;
}

/** The public surface returned by {@link createRelay}. */
export interface Relay<TTx> {
  /** Ride the business TX (fail-closed). `trx` is required (basic design section 8.1). */
  enqueue(trx: TTx, input: EnqueueInput): Promise<{ id: string }>;
  /** Non-TX enqueue. Loses the atomicity guarantee; use only when there is no business TX. */
  enqueueUnsafe(input: EnqueueInput): Promise<{ id: string }>;
  /** Create a background dispatcher bound to this relay's store/deliver/config. */
  createDispatcher(options?: DispatcherOptions): Dispatcher;
  /** Read the delivery ledger for one outbox row. */
  attempts(opts: { outboxId: string }): Promise<DeliveryAttempt[]>;
  /** Replay matching rows as fresh pending copies; returns the new ids. */
  replay(opts: { outboxId: string } | { filter: ReplayFilter }): Promise<{ ids: string[] }>;
  endpoints: { disable(endpointId: string): Promise<void> };
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

export async function createRelay<TTx>(config: RelayInit<TTx>): Promise<Relay<TTx>> {
  const { store, ...rest } = config;
  const resolved = resolveConfig(rest);

  const diag = await store.diagnose();
  if (!diag.ok) {
    throw new RelayError(
      "MISSING_TABLES",
      `required tables missing: ${diag.missingTables.join(", ")}`,
    );
  }

  const http = createHttpClient({ ssrf: resolved.ssrf, delivery: resolved.delivery });
  const deliver = (row: OutboxRow): Promise<void> =>
    deliverOne(row, { store, http, config: resolved, clock: resolved.clock });

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
      id: randomUUID(),
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
    endpoints: {
      disable(endpointId) {
        return adminDisable(store, endpointId, resolved.clock());
      },
    },
  };
}
