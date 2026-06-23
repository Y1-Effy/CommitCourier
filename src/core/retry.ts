/**
 * Exponential backoff with jitter (per 01-core section 4, basic design section 10).
 */
import type { RetryConfig } from "./types";

/**
 * Compute the backoff delay in milliseconds before the next attempt.
 *
 * @param attempts - How many attempts this failure makes it (1-based).
 * @param cfg - Retry policy.
 * @param rnd - Injectable RNG in `[0, 1)`; defaults to `Math.random` for deterministic tests.
 * @returns A non-negative integer delay in milliseconds.
 */
export function backoffMs(
  attempts: number,
  cfg: RetryConfig,
  rnd: () => number = Math.random,
): number {
  const raw = cfg.baseMs * 2 ** (attempts - 1); // exponential
  const capped = Math.min(raw, cfg.capMs); // cap
  const span = capped * cfg.jitter; // +/- jitter
  const delta = (rnd() * 2 - 1) * span; // [-span, +span]
  return Math.max(0, Math.round(capped + delta));
}
