/**
 * `commitcourier` main entry.
 *
 * Re-exports the pure core public API and the store port/DTO types. Driver adapters are
 * published under the subpath exports `commitcourier/store/pg` and `commitcourier/store/knex` so that
 * importing this entry never pulls a specific DB driver into scope.
 */
export * from "./core/index";
export type {
  Store,
  NewOutboxRow,
  NewDeliveryAttempt,
  NewEndpointRow,
  EndpointPatch,
  OutboxStats,
  ReplayFilter,
  OutboxListItem,
  OutboxListFilter,
  EndpointSummary,
  EndpointListFilter,
  Page,
} from "./store/store";

export { createRelay } from "./relay";
export type { Relay, RelayInit, EndpointAdmin, RegisterEndpointInput } from "./relay";
export type { PruneOptions } from "./admin/admin";
export type {
  DeliveryHooks,
  DeliveryEvent,
  DeliveryStart,
  DeliveryInstrument,
} from "./delivery/deliver";
export type { Dispatcher, DispatcherOptions, RunOnceOptions } from "./dispatcher/dispatcher";
export type { Accelerator, WakeSignal } from "./accelerator/accelerator";
// `sink` transport port abstraction; referenced by `RelayInit.sink`. The Svix sample
// adapter ships under the `commitcourier/forward/svix` subpath so its optional peer never loads here.
export type { Sink, SinkEvent, SinkResult } from "./forward/index";
