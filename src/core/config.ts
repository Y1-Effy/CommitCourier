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
  delivery: { timeoutMs: 15_000, bodySnippetBytes: 4_096 },
  ssrf: { blockPrivateRanges: true, allowlist: [] as string[], blocklist: [] as string[] },
} as const satisfies Omit<RelayConfig, "clock" | "logger">;

function fail(message: string): never {
  throw new RelayError("CONFIG_INVALID", message);
}

/** Validate hard constraints; throws `RelayError("CONFIG_INVALID")` on violation. */
function validate(cfg: Omit<RelayConfig, "clock" | "logger">): void {
  // scheme is typed to a single literal but can be anything from untyped runtime input.
  if ((cfg.signing.scheme as string) !== "standard-webhooks") {
    fail(`Unsupported signing scheme: ${cfg.signing.scheme}`);
  }
  const { maxAttempts, baseMs, capMs, jitter } = cfg.retry;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    fail(`retry.maxAttempts must be an integer >= 1, got ${String(maxAttempts)}`);
  }
  if (!(baseMs > 0)) {
    fail(`retry.baseMs must be > 0, got ${String(baseMs)}`);
  }
  if (!(capMs > 0)) {
    fail(`retry.capMs must be > 0, got ${String(capMs)}`);
  }
  if (!(jitter >= 0 && jitter <= 1)) {
    fail(`retry.jitter must be within 0..1, got ${String(jitter)}`);
  }
  if (!(cfg.delivery.timeoutMs > 0)) {
    fail(`delivery.timeoutMs must be > 0, got ${String(cfg.delivery.timeoutMs)}`);
  }
  if (!(cfg.delivery.bodySnippetBytes > 0)) {
    fail(`delivery.bodySnippetBytes must be > 0, got ${String(cfg.delivery.bodySnippetBytes)}`);
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

/** Fill defaults into a partial config, validate, and return a deeply frozen config. */
export function resolveConfig(input: DeepPartial<RelayConfig>): RelayConfig {
  const merged: Omit<RelayConfig, "clock" | "logger"> = {
    mode: input.mode ?? DEFAULTS.mode,
    signing: { scheme: input.signing?.scheme ?? DEFAULTS.signing.scheme },
    retry: { ...DEFAULTS.retry, ...input.retry },
    delivery: { ...DEFAULTS.delivery, ...input.delivery },
    ssrf: {
      blockPrivateRanges: input.ssrf?.blockPrivateRanges ?? DEFAULTS.ssrf.blockPrivateRanges,
      allowlist: input.ssrf?.allowlist ?? [],
      blocklist: input.ssrf?.blocklist ?? [],
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
      allowlist: Object.freeze([...merged.ssrf.allowlist]) as string[],
      blocklist: Object.freeze([...merged.ssrf.blocklist]) as string[],
    }),
    clock: input.clock ?? (() => new Date()),
    logger,
  });
}
