/**
 * Config resolution, defaulting and startup validation (per 01-core section 7,
 * basic design section 17).
 *
 * Invalid configuration is rejected fail-fast with `RelayError("CONFIG_INVALID")`.
 * Dangerous-but-valid settings (e.g. disabling SSRF protection) are allowed but warned
 * through the logger. Defaults mirror the single-source table in 00-overview section 6.
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

/** Default configuration values (single source of truth: 00-overview section 6). */
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

/** Validate the retry policy; `backoff` is typed to a literal but may be untyped at runtime. */
function validateRetry(retry: RelayConfig["retry"]): void {
  const { maxAttempts, backoff, baseMs, capMs, jitter } = retry;
  if ((backoff as string) !== "exponential") {
    fail(`retry.backoff must be "exponential", got ${backoff}`);
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    fail(`retry.maxAttempts must be an integer >= 1, got ${String(maxAttempts)}`);
  }
  if (!(baseMs > 0)) {
    fail(`retry.baseMs must be > 0, got ${String(baseMs)}`);
  }
  if (!(capMs > 0)) {
    fail(`retry.capMs must be > 0, got ${String(capMs)}`);
  }
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
  if (!(delivery.timeoutMs > 0)) {
    fail(`delivery.timeoutMs must be > 0, got ${String(delivery.timeoutMs)}`);
  }
  if (!(delivery.bodySnippetBytes > 0)) {
    fail(`delivery.bodySnippetBytes must be > 0, got ${String(delivery.bodySnippetBytes)}`);
  }
  if (!(delivery.keepAliveTimeoutMs > 0)) {
    fail(`delivery.keepAliveTimeoutMs must be > 0, got ${String(delivery.keepAliveTimeoutMs)}`);
  }
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
  };
  validate(merged);

  // Merge over the no-op so any methods the caller omits still exist.
  const logger: Logger = { ...NOOP_LOGGER, ...input.logger };
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
    clock: input.clock ?? (() => new Date()),
    logger,
  });
}
