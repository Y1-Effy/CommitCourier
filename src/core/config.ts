/**
 * Config resolution, defaulting and startup validation.
 *
 * Invalid configuration is rejected fail-fast with `RelayError("CONFIG_INVALID")`.
 * Dangerous-but-valid settings (e.g. disabling SSRF protection) are allowed but warned
 * through the logger. Defaults come from a single source of truth (see {@link DEFAULTS}).
 */
import { RelayError } from "./errors";
import type { Logger } from "./shared";
import type { RelayConfig } from "./types";

/** Recursive partial that keeps arrays and functions (e.g. `Clock`) assignable as a whole. */
export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : // eslint-disable-next-line @typescript-eslint/no-explicit-any
    T extends (...args: any[]) => unknown
    ? T
    : T extends object
      ? { [K in keyof T]?: DeepPartial<T[K]> }
      : T;

const NOOP_LOGGER: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/**
 * Wrap a {@link Logger} so a throwing method can never escape into a caller. Every log site in the
 * library sits on a fail-open path — delivery, the dispatcher loop, and the critical safety net all
 * call `logger.error`/`logger.warn` from inside the catch blocks that ARE the fail-open guarantee — so
 * a misbehaving logger (one whose method throws, e.g. a transport that fails under backpressure) must
 * degrade to a no-op rather than reject a delivery promise and stop the dispatcher. Unlike hooks /
 * instrument / sink (each already wrapped fail-open), the logger was the one injected component still
 * called unguarded. core forbids `console`, so a thrown error is simply swallowed here.
 */
function safeLogger(inner: Logger): Logger {
  const wrap =
    (level: keyof Logger) =>
    (msg: string, meta?: Record<string, unknown>): void => {
      try {
        // Preserve the call arity (pass meta only when present), so a wrapped logger is indistinguishable
        // from the raw one to a caller/spy — mirrors createConsoleLogger.
        if (meta === undefined) inner[level](msg);
        else inner[level](msg, meta);
      } catch {
        // fail-open: a throwing logger must never propagate into the delivery/dispatch path.
      }
    };
  return { debug: wrap("debug"), info: wrap("info"), warn: wrap("warn"), error: wrap("error") };
}

/** Default configuration values (the single source of truth for defaults). */
const DEFAULTS = {
  mode: "active",
  signing: { scheme: "standard-webhooks" },
  retry: { maxAttempts: 12, backoff: "exponential", baseMs: 1_000, capMs: 3_600_000, jitter: 0.2 },
  delivery: {
    transport: "http",
    timeoutMs: 15_000,
    bodySnippetBytes: 4_096,
    keepAliveTimeoutMs: 10_000,
  },
  ssrf: {
    blockPrivateRanges: true,
    allowlist: [] as readonly string[],
    blocklist: [] as readonly string[],
  },
  circuitBreaker: { failureThreshold: 0, cooldownMs: 0 },
} as const satisfies Omit<RelayConfig, "clock" | "logger">;

function fail(message: string): never {
  throw new RelayError("CONFIG_INVALID", message);
}

/**
 * Reject a numeric setting unless it is a finite positive integer. `Number.isInteger` already rejects
 * `NaN`, `Infinity` and fractions (so a typo'd `1500.5` or a stray `Infinity` cannot slip through a
 * bare `> 0` check), and the `> 0` guard rejects `0` and negatives.
 */
function requirePositiveInt(name: string, value: number): void {
  if (!(Number.isInteger(value) && value > 0)) {
    fail(`${name} must be a finite positive integer, got ${String(value)}`);
  }
}

/** Validate the retry policy; `backoff` is typed to a literal but may be untyped at runtime. */
function validateRetry(retry: RelayConfig["retry"]): void {
  const { maxAttempts, backoff, baseMs, capMs, jitter } = retry;
  if ((backoff as string) !== "exponential") {
    fail(`retry.backoff must be "exponential", got ${backoff}`);
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    fail(`retry.maxAttempts must be an integer >= 1, got ${String(maxAttempts)}`);
  }
  requirePositiveInt("retry.baseMs", baseMs);
  requirePositiveInt("retry.capMs", capMs);
  if (!(capMs >= baseMs)) {
    fail(
      `retry.capMs must be >= retry.baseMs, got capMs=${String(capMs)}, baseMs=${String(baseMs)}`,
    );
  }
  if (!(jitter >= 0 && jitter <= 1)) {
    fail(`retry.jitter must be within 0..1, got ${String(jitter)}`);
  }
}

/** Validate the delivery policy; values are typed but may be untyped at runtime. */
function validateDelivery(delivery: RelayConfig["delivery"]): void {
  // transport is typed to a literal but can be anything from untyped runtime input.
  if ((delivery.transport as string) !== "http" && (delivery.transport as string) !== "sink") {
    fail(`delivery.transport must be "http" or "sink", got ${delivery.transport}`);
  }
  requirePositiveInt("delivery.timeoutMs", delivery.timeoutMs);
  requirePositiveInt("delivery.bodySnippetBytes", delivery.bodySnippetBytes);
  requirePositiveInt("delivery.keepAliveTimeoutMs", delivery.keepAliveTimeoutMs);
  if (
    delivery.connections !== undefined &&
    !(Number.isInteger(delivery.connections) && delivery.connections >= 1)
  ) {
    fail(`delivery.connections must be an integer >= 1, got ${String(delivery.connections)}`);
  }
}

/** Validate the circuit-breaker policy; values are typed but may be untyped at runtime. */
function validateCircuitBreaker(cb: RelayConfig["circuitBreaker"]): void {
  if (!(Number.isInteger(cb.failureThreshold) && cb.failureThreshold >= 0)) {
    fail(
      `circuitBreaker.failureThreshold must be an integer >= 0 (0 disables), got ${String(cb.failureThreshold)}`,
    );
  }
  if (!(Number.isInteger(cb.cooldownMs) && cb.cooldownMs >= 0)) {
    fail(
      `circuitBreaker.cooldownMs must be an integer >= 0 (0 disables auto-recovery), got ${String(cb.cooldownMs)}`,
    );
  }
}

/** Validate hard constraints; throws `RelayError("CONFIG_INVALID")` on violation. */
function validate(cfg: Omit<RelayConfig, "clock" | "logger">): void {
  // mode/scheme are typed to literals but can be anything from untyped runtime input.
  if ((cfg.mode as string) !== "observe" && (cfg.mode as string) !== "active") {
    fail(`mode must be "observe" or "active", got ${cfg.mode}`);
  }
  if ((cfg.signing.scheme as string) !== "standard-webhooks") {
    fail(`Unsupported signing scheme: ${cfg.signing.scheme}`);
  }
  validateRetry(cfg.retry);
  validateDelivery(cfg.delivery);
  validateCircuitBreaker(cfg.circuitBreaker);
  // Optional: only validate when the caller opted in (omitted = no limit).
  if (cfg.maxPayloadBytes !== undefined) {
    requirePositiveInt("maxPayloadBytes", cfg.maxPayloadBytes);
  }
}

/** Emit non-fatal warnings for dangerous-but-valid settings. */
function warnIfRisky(cfg: Omit<RelayConfig, "clock" | "logger">, logger: Logger): void {
  if (!cfg.ssrf.blockPrivateRanges) {
    logger.warn(
      "ssrf.blockPrivateRanges is disabled; private/loopback/metadata destinations are reachable",
    );
  }
  if (cfg.retry.baseMs * 2 ** (cfg.retry.maxAttempts - 1) > cfg.retry.capMs) {
    logger.warn("retry backoff saturates retry.capMs before reaching retry.maxAttempts", {
      baseMs: cfg.retry.baseMs,
      maxAttempts: cfg.retry.maxAttempts,
      capMs: cfg.retry.capMs,
    });
  }
}

/** Merge the SSRF policy with its defaults (extracted to keep resolveConfig's complexity in budget). */
function mergeSsrf(input: DeepPartial<RelayConfig>["ssrf"]): RelayConfig["ssrf"] {
  return {
    blockPrivateRanges: input?.blockPrivateRanges ?? DEFAULTS.ssrf.blockPrivateRanges,
    allowlist: input?.allowlist ?? [],
    blocklist: input?.blocklist ?? [],
  };
}

/** Fill defaults into a partial config, validate, and return a deeply frozen config. */
export function resolveConfig(input: DeepPartial<RelayConfig>): RelayConfig {
  const merged: Omit<RelayConfig, "clock" | "logger"> = {
    mode: input.mode ?? DEFAULTS.mode,
    signing: { scheme: input.signing?.scheme ?? DEFAULTS.signing.scheme },
    retry: { ...DEFAULTS.retry, ...input.retry },
    delivery: { ...DEFAULTS.delivery, ...input.delivery },
    ssrf: mergeSsrf(input.ssrf),
    circuitBreaker: {
      failureThreshold:
        input.circuitBreaker?.failureThreshold ?? DEFAULTS.circuitBreaker.failureThreshold,
      cooldownMs: input.circuitBreaker?.cooldownMs ?? DEFAULTS.circuitBreaker.cooldownMs,
    },
    // Optional, off by default: left undefined unless the caller sets it.
    maxPayloadBytes: input.maxPayloadBytes,
  };
  validate(merged);

  // Merge over the no-op so any methods the caller omits still exist, then wrap fail-open so a
  // throwing logger can never escape into the delivery/dispatch path (see safeLogger).
  const logger: Logger = safeLogger({ ...NOOP_LOGGER, ...input.logger });
  warnIfRisky(merged, logger);

  return Object.freeze({
    mode: merged.mode,
    signing: Object.freeze(merged.signing),
    retry: Object.freeze(merged.retry),
    delivery: Object.freeze(merged.delivery),
    ssrf: Object.freeze({
      blockPrivateRanges: merged.ssrf.blockPrivateRanges,
      allowlist: Object.freeze([...merged.ssrf.allowlist]),
      blocklist: Object.freeze([...merged.ssrf.blocklist]),
    }),
    circuitBreaker: Object.freeze(merged.circuitBreaker),
    maxPayloadBytes: merged.maxPayloadBytes,
    clock: input.clock ?? (() => new Date()),
    logger,
  });
}
