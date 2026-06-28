/**
 * Table/status names, list limits, and their clamps — the leaf constants the rest of the SQL
 * plumbing builds on. No dependency on other store modules.
 */
import type { Status } from "../../core/index";
import initSql from "./001_init.sql";

export const OUTBOX_TABLE = "webhook_outbox";
export const ATTEMPTS_TABLE = "webhook_delivery_attempts";
export const ENDPOINTS_TABLE = "webhook_endpoints";

/** Tables whose absence makes the store non-functional (diagnose reports ok:false). */
export const CORE_TABLES = [OUTBOX_TABLE, ATTEMPTS_TABLE] as const;
/** All tables, including the optional registered-endpoint table. */
export const ALL_TABLES = [OUTBOX_TABLE, ATTEMPTS_TABLE, ENDPOINTS_TABLE] as const;

/**
 * The canonical DDL. Embedded into the bundle as a string at build time (esbuild `text` loader),
 * so there is no runtime file I/O — this survives both ESM/CJS output and downstream re-bundling.
 */
export function loadInitSql(): string {
  return initSql;
}

/** Every lifecycle status, used to zero-fill {@link "./query-builders".countsFromRows} (mirrors the DDL CHECK). */
export const ALL_STATUSES = [
  "pending",
  "in_flight",
  "delivered",
  "dead",
  "observed",
  "cancelled",
] as const satisfies readonly Status[];

/** Statuses a `prune` is allowed to delete (never `pending`/`in_flight`). */
export const PRUNABLE_STATUSES = ["delivered", "dead", "cancelled", "observed"] as const;
/** Default statuses pruned when the caller does not specify (keeps `observed` for audit). */
export const DEFAULT_PRUNE_STATUSES: Status[] = ["delivered", "dead", "cancelled"];

/** Default cap on a single `replay` call; the admin layer applies it when no explicit limit is set. */
export const REPLAY_DEFAULT_LIMIT = 1_000;
/** Hard ceiling on one `replay` call so a filter can never fan out into an unbounded mass re-send. */
export const REPLAY_MAX_LIMIT = 10_000;

/** Clamp a requested replay limit into `(0, REPLAY_MAX_LIMIT]`, defaulting when absent/invalid. */
export function clampReplayLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return REPLAY_DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), REPLAY_MAX_LIMIT);
}

/** Default rows deleted per `prune` call when the caller omits `limit`. */
export const PRUNE_DEFAULT_LIMIT = 10_000;
/** Hard ceiling on one `prune` batch so a single call cannot delete (and lock) an unbounded set. */
export const PRUNE_MAX_LIMIT = 100_000;

/** Clamp a requested prune limit into `(0, PRUNE_MAX_LIMIT]`, defaulting when absent/invalid. */
export function clampPruneLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return PRUNE_DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), PRUNE_MAX_LIMIT);
}

/** Default page size for the list APIs when the caller omits `limit`. */
export const LIST_DEFAULT_LIMIT = 50;
/** Hard ceiling on a list page so a caller cannot ask for an unbounded scan. */
export const LIST_MAX_LIMIT = 500;

/** Clamp a requested page size into `(0, LIST_MAX_LIMIT]`, defaulting when absent/invalid. */
export function clampListLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return LIST_DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), LIST_MAX_LIMIT);
}
