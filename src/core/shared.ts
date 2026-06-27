/**
 * Cross-cutting primitive types shared across all modules.
 *
 * Kept in a separate file from {@link "./types"} so that lower-level helpers can
 * depend on these primitives without creating an import cycle (per 00-overview section 4).
 */

/** Injectable clock. Can be fixed in tests. Defaults to `() => new Date()`. */
export type Clock = () => Date;

/**
 * Injectable logger. Defaults to a no-op.
 *
 * Independent of the delivery instrumentation seam: tracing/metrics go through `RelayInit.instrument`
 * / `hooks` and the optional `commitcourier/otel` adapter, not this logger.
 */
export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** Lifecycle status of an outbox row (basic design section 7). */
export type Status = "pending" | "in_flight" | "delivered" | "dead" | "observed" | "cancelled";

/** Delivery mode. `observe` records without ever sending (staged rollout, section 15). */
export type Mode = "observe" | "active";
