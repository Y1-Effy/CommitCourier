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

/**
 * Parse an HTTP `Retry-After` header into a delay in milliseconds, or null when absent/invalid.
 *
 * Both forms (RFC 9110) are accepted: a non-negative delta-seconds integer, or an HTTP-date whose
 * delay is `date - now`. A past date, a negative delta, or an unparseable value yields null (caller
 * falls back to its own backoff). Pure: uses only `Date.parse` (a Web standard), no Node globals.
 *
 * @param value - The raw header value, or null when the response carried none.
 * @param nowMs - Current time in epoch ms, used to turn an HTTP-date into a relative delay.
 */
export function parseRetryAfter(value: string | null | undefined, nowMs: number): number | null {
  if (value == null) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  // delta-seconds: a bare non-negative integer.
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  // HTTP-date: anything Date.parse understands; keep only a non-negative future delay.
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return null;
  const delta = dateMs - nowMs;
  return delta > 0 ? delta : null;
}
