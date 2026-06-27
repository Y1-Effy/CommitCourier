/**
 * Cross-cutting primitive types shared across all modules.
 *
 * Kept in a separate file from {@link "./types"} so that lower-level helpers can
 * depend on these primitives without creating an import cycle.
 */

/** Injectable clock. Can be fixed in tests. Defaults to `() => new Date()`. */
export type Clock = () => Date;

/**
 * Injectable logger. Defaults to a no-op, so routine operational logs (delivery failures, retries) are
 * silent unless one is provided. The two critical categories — security (SSRF blocks) and data loss
 * (DLQ transitions) — fall back to the `console` even with no logger configured, so they are never
 * silent; pass a logger (e.g. {@link createConsoleLogger}) to capture everything.
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

/**
 * A ready-made {@link Logger} backed by the `console` global — a safe, copy-paste default so a relay
 * is not silent in production. Because delivery is fail-open, an unset logger swallows routine delivery
 * failures and retries (DLQ transitions and SSRF blocks still fall back to the console); passing this
 * (or any `Logger`) makes every operational log observable.
 *
 * Messages are prefixed with `commitcourier`; `debug`/`info`/`warn`/`error` map to the matching console
 * method (`debug` falls back to `console.log`). The library never logs signing secrets, so this is safe
 * to wire directly. For structured logging, adapt your own logger to the {@link Logger} interface instead.
 */
export function createConsoleLogger(prefix = "commitcourier"): Logger {
  const emit =
    (method: "log" | "info" | "warn" | "error") =>
    (msg: string, meta?: Record<string, unknown>): void => {
      if (meta === undefined) console[method](`[${prefix}] ${msg}`);
      else console[method](`[${prefix}] ${msg}`, meta);
    };
  return {
    debug: emit("log"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
  };
}

/** Lifecycle status of an outbox row. */
export type Status = "pending" | "in_flight" | "delivered" | "dead" | "observed" | "cancelled";

/** Delivery mode. `observe` records without ever sending (staged rollout). */
export type Mode = "observe" | "active";
