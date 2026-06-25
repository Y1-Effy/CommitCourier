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
} from "./store/store";

export { createRelay } from "./relay";
export type { Relay, RelayInit, EndpointAdmin, RegisterEndpointInput } from "./relay";
export type { DeliveryHooks, DeliveryEvent } from "./delivery/deliver";
export type { Dispatcher, DispatcherOptions } from "./dispatcher/dispatcher";
