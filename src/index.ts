/**
 * `relaybox` main entry.
 *
 * Re-exports the pure core public API and the store port/DTO types. Driver adapters are
 * published under the subpath exports `relaybox/store/pg` and `relaybox/store/knex` so that
 * importing this entry never pulls a specific DB driver into scope.
 */
export * from "./core/index";
export type { Store, NewOutboxRow, NewDeliveryAttempt, ReplayFilter } from "./store/store";
