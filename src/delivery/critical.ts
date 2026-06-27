/**
 * Critical-event surfacing for the delivery path.
 *
 * Routine operational logs (delivery failures, retries) go through the injected {@link Logger} and
 * stay silent when no logger is configured (the default is a no-op). Two categories are different:
 * a **security event** (an SSRF block) and **data loss** (a message reaching the terminal `dead`
 * state, i.e. the DLQ) must not vanish just because the logger was not wired. This logger always
 * forwards to the configured logger and, only when no logger was configured, also falls back to the
 * `console` so the event is visible — and says so in the message.
 *
 * Lives in the delivery layer (not `core`) because it uses the `console` global, which `core` forbids.
 */
import type { Logger } from "../core/index";

/** Surfaces security/data-loss events even when no {@link Logger} was configured (internal). */
export interface CriticalLogger {
  /** A delivery was refused because the destination resolved to a blocked address (SSRF). */
  securityBlocked(msg: string, meta?: Record<string, unknown>): void;
  /** A message reached the terminal `dead` state and is permanently lost (the DLQ). */
  dataLoss(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Build a {@link CriticalLogger}. When `loggerConfigured` is false the injected `logger` is the
 * no-op default, so the event would otherwise be silent; in that case we also emit to the `console`
 * and note that no logger is configured. When a logger is configured we trust it and never duplicate
 * to the console.
 */
export function createCriticalLogger(logger: Logger, loggerConfigured: boolean): CriticalLogger {
  const dual =
    (level: "warn" | "error") =>
    (msg: string, meta?: Record<string, unknown>): void => {
      logger[level](msg, meta); // the configured logger always sees it (a no-op if unset)
      if (!loggerConfigured) {
        // Misconfiguration safety net: a security/data-loss event must not be silent.
        const note = { ...meta, loggerConfigured: false };
        console[level](
          `[commitcourier] ${msg} (no logger configured; pass \`logger\` to capture this)`,
          note,
        );
      }
    };
  return { securityBlocked: dual("warn"), dataLoss: dual("error") };
}
