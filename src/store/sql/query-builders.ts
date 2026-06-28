/**
 * SQL string builders and constants shared across the relational adapters. Every builder emits
 * numbered (`$n`) Postgres SQL; the knex adapter translates each statement to positional `?` via
 * `numberedToQmark` just before `knex.raw`. Also the list/paging query builders and the
 * dialect-agnostic result folders (paging, diagnose, stats).
 */
import type { Status } from "../../core/index";
import type {
  ReplayFilter,
  OutboxListItem,
  OutboxListFilter,
  EndpointSummary,
  EndpointListFilter,
} from "../store";
import {
  OUTBOX_TABLE,
  ATTEMPTS_TABLE,
  ENDPOINTS_TABLE,
  ALL_TABLES,
  CORE_TABLES,
  ALL_STATUSES,
  clampListLimit,
} from "./constants";
import { ATTEMPT_COLUMNS, OUTBOX_LIST_COLUMNS, ENDPOINT_LIST_COLUMNS } from "./columns";
import {
  mapOutboxListItem,
  mapEndpointSummary,
  type RawOutboxListRow,
  type RawEndpointSummaryRow,
} from "./row-mappers";

/** The jsonb column among attempt columns (cast to `::jsonb` like `payload`). */
const ATTEMPT_JSON_COLUMN = "request_headers";

/**
 * Build the `completeAttempt` CTE for the given transition SET columns. Emits numbered (`$n`) SQL
 * (the knex adapter translates it to positional `?` via `numberedToQmark`). Bindings follow textual
 * order — the {@link ATTEMPT_COLUMNS} values, then the transition values (matching `setColumns`),
 * then the outbox id, then (when `opts.guardLockedBy`) the expected `locked_by` — so the translation
 * is mechanical.
 *
 * `opts.guardLockedBy` adds `AND locked_by = $k` to the transition's WHERE so a delivery only
 * transitions a row that is *still the one it claimed*. After a visibility-timeout reclaim re-locks
 * the row to a different worker, the stale worker's transition becomes a no-op (its ledger row is
 * still inserted — every attempt is recorded; only the state write is guarded). The guard is
 * evaluated against the pre-UPDATE row, so a transition that clears `locked_by` is unaffected.
 * Omitted (the default) preserves the status-only guard for backward compatibility.
 */
export function completeAttemptSql(
  setColumns: string[],
  opts: { guardLockedBy?: boolean } = {},
): string {
  const ph = (n: number): string => `$${String(n)}`;
  const values = ATTEMPT_COLUMNS.map((c, i) =>
    c === ATTEMPT_JSON_COLUMN ? `${ph(i + 1)}::jsonb` : ph(i + 1),
  );
  // Placeholders follow textual order (attempt values, then SET values, then id, then locked_by).
  const setStart = ATTEMPT_COLUMNS.length + 1;
  const set = setColumns.map((c, i) => `${c} = ${ph(setStart + i)}`).join(", ");
  const idPos = setStart + setColumns.length;
  const lockGuard = opts.guardLockedBy ? ` AND locked_by = ${ph(idPos + 1)}` : "";
  return `WITH ins AS (
  INSERT INTO ${ATTEMPTS_TABLE} (${ATTEMPT_COLUMNS.join(", ")}) VALUES (${values.join(", ")})
)
UPDATE ${OUTBOX_TABLE} SET ${set} WHERE id = ${ph(idPos)} AND status = 'in_flight'${lockGuard}`;
}

/** Build `INSERT INTO t (cols) VALUES ($1, $2, ...)`, casting the named jsonb column to `::jsonb`. */
export function insertClause(
  table: string,
  columns: readonly string[],
  jsonColumn: string,
): string {
  const placeholders = columns
    .map((c, i) => (c === jsonColumn ? `$${String(i + 1)}::jsonb` : `$${String(i + 1)}`))
    .join(", ");
  return `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders})`;
}

/** Build a multi-row INSERT (`(cols) VALUES (...),(...)`), casting the jsonb column per row. */
export function insertManyClause(
  table: string,
  columns: readonly string[],
  jsonColumn: string,
  rowCount: number,
): string {
  const tuples: string[] = [];
  for (let r = 0; r < rowCount; r++) {
    const ph = columns.map((c, i) => {
      const n = r * columns.length + i + 1;
      return c === jsonColumn ? `$${String(n)}::jsonb` : `$${String(n)}`;
    });
    tuples.push(`(${ph.join(", ")})`);
  }
  return `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${tuples.join(", ")}`;
}

/**
 * Build the dynamic WHERE for a {@link ReplayFilter}: `{ sql, params }`. Replay only ever targets
 * non-active rows: an always-present `status NOT IN ('pending','in_flight')` guard keeps a live row
 * (one the dispatcher will deliver on its own) from being copied into a duplicate, mirroring the way
 * `prune` refuses to touch active rows. The guard is a literal (no bind), so the same SQL is valid
 * for every placeholder style.
 */
export function replayWhere(filter: ReplayFilter): { sql: string; params: unknown[] } {
  const conds: string[] = ["status NOT IN ('pending', 'in_flight')"];
  const params: unknown[] = [];
  if (filter.outboxId !== undefined) {
    params.push(filter.outboxId);
    conds.push(`id = $${String(params.length)}`);
  }
  if (filter.status !== undefined) {
    params.push(filter.status);
    conds.push(`status = $${String(params.length)}`);
  }
  if (filter.since !== undefined) {
    params.push(filter.since);
    conds.push(`created_at >= $${String(params.length)}`);
  }
  if (filter.endpointId !== undefined) {
    params.push(filter.endpointId);
    conds.push(`endpoint_id = $${String(params.length)}`);
  }
  return { sql: `WHERE ${conds.join(" AND ")}`, params };
}

/**
 * Cancel a not-yet-sent row: `pending` -&gt; `cancelled`, guarded so an already-claimed/terminal row is
 * untouched (mirrors `core/state.onCancel`). One `$1` placeholder (the id); a no-op match means there
 * was nothing to cancel. Shared by every `$n` adapter; knex builds the equivalent guarded UPDATE.
 */
export const CANCEL_PENDING_SQL = `UPDATE ${OUTBOX_TABLE} SET status = 'cancelled', locked_at = NULL, locked_by = NULL WHERE id = $1 AND status = 'pending'`;

/**
 * Reset a registered endpoint's consecutive-failure counter after a successful delivery. Guarded on
 * `consecutive_failures <> 0` so a healthy endpoint (already 0) takes no write on the hot path.
 */
export const NOTE_ENDPOINT_SUCCESS_SQL = `UPDATE ${ENDPOINTS_TABLE} SET consecutive_failures = 0 WHERE id = $1 AND consecutive_failures <> 0`;

/**
 * Re-activate a disabled endpoint after a successful half-open trial: clear the disabled marker and
 * reset the failure counter in one UPDATE (`status = 'active'`, `consecutive_failures = 0`,
 * `disabled_at = NULL`). One `$1` placeholder (the id). Used by the circuit breaker's auto-recovery.
 */
export const REACTIVATE_ENDPOINT_SQL = `UPDATE ${ENDPOINTS_TABLE} SET status = 'active', consecutive_failures = 0, disabled_at = NULL WHERE id = $1`;

/**
 * Build the circuit-breaker failure UPDATE: atomically increment `consecutive_failures` and, when
 * the new count reaches the threshold while still `active`, disable the endpoint in the same
 * statement (so the increment and the auto-disable can never diverge under concurrency). Emits
 * numbered (`$n`) SQL — the threshold reuses `$2` — with bindings `[id, threshold, now]`. The knex
 * adapter translates it to positional `?` via `numberedToQmark`, which re-binds the reused `$2`.
 */
export function buildNoteEndpointFailureSql(): string {
  return `UPDATE ${ENDPOINTS_TABLE} SET consecutive_failures = consecutive_failures + 1, status = CASE WHEN consecutive_failures + 1 >= $2 AND status = 'active' THEN 'disabled' ELSE status END, disabled_at = CASE WHEN consecutive_failures + 1 >= $2 AND status = 'active' THEN $3 ELSE disabled_at END WHERE id = $1`;
}

/** Ordered bindings for {@link buildNoteEndpointFailureSql}: `[id, threshold, now]` (`$2` is reused). */
export function noteEndpointFailureParams(id: string, now: Date, threshold: number): unknown[] {
  return [id, threshold, now];
}

/**
 * Build the retention DELETE. A bounded inner SELECT (oldest-first, `LIMIT`) picks the ids to delete
 * so one call never deletes an unbounded set or holds a table-wide lock; the outer DELETE removes
 * them (ledger attempts cascade). The `statusCount` statuses are expanded into individual `IN (...)`
 * placeholders (rather than a bound array) so every driver — including Prisma and knex.raw — binds
 * plain scalars uniformly. Emits numbered (`$n`) SQL with bindings in textual order: the statuses,
 * then `olderThan`, then `limit` (the knex adapter translates to positional `?` via `numberedToQmark`).
 */
export function buildPruneSql(statusCount: number): string {
  let n = 0;
  const ph = (): string => `$${String(++n)}`;
  const inList = Array.from({ length: statusCount }, () => ph()).join(", ");
  const olderThan = ph();
  const limit = ph();
  return `DELETE FROM ${OUTBOX_TABLE} WHERE id IN (SELECT id FROM ${OUTBOX_TABLE} WHERE status IN (${inList}) AND created_at < ${olderThan} ORDER BY created_at LIMIT ${limit})`;
}

/** Ordered bindings for {@link buildPruneSql}: the statuses, then `olderThan`, then `limit`. */
export function pruneParams(statuses: Status[], olderThan: Date, limit: number): unknown[] {
  return [...statuses, olderThan, limit];
}

/**
 * Single-row, secret-free outbox fetch by id (reuses the secret-free list columns, so the
 * encrypted-store decorator passes it through without decryption). One `$1` placeholder; knex
 * builds the equivalent `select(...).where('id', ...)`.
 */
export const GET_OUTBOX_SQL = `SELECT ${OUTBOX_LIST_COLUMNS.join(", ")} FROM ${OUTBOX_TABLE} WHERE id = $1`;

/** A built statement (numbered `$n`) with its ordered bindings. */
interface BuiltQuery {
  sql: string;
  params: unknown[];
}

/**
 * Build the secret-free outbox list query. Newest-first by `seq` (a stable, monotonic keyset),
 * filtered by the optional status/since/endpointId, with seq-keyset paging (`seq < cursor`). The
 * cursor placeholder is cast to `::bigint` so Prisma — which would otherwise infer text — compares it
 * against the bigint column. Emits numbered (`$n`) SQL with bindings in textual order (the knex
 * adapter translates to positional `?` via `numberedToQmark`).
 */
export function buildOutboxListQuery(filter: OutboxListFilter): BuiltQuery {
  const params: unknown[] = [];
  const ph = (): string => `$${String(params.length)}`;
  const conds: string[] = [];
  if (filter.status !== undefined) {
    params.push(filter.status);
    conds.push(`status = ${ph()}`);
  }
  if (filter.since !== undefined) {
    params.push(filter.since);
    conds.push(`created_at >= ${ph()}`);
  }
  if (filter.endpointId !== undefined) {
    params.push(filter.endpointId);
    conds.push(`endpoint_id = ${ph()}`);
  }
  if (filter.cursor !== undefined) {
    params.push(filter.cursor);
    conds.push(`seq < (${ph()})::bigint`);
  }
  const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
  params.push(clampListLimit(filter.limit));
  const sql = `SELECT ${OUTBOX_LIST_COLUMNS.join(", ")} FROM ${OUTBOX_TABLE} ${where} ORDER BY seq DESC LIMIT ${ph()}`;
  return { sql, params };
}

/**
 * Build the secret-free endpoint list query. Ordered by `id` (a unique keyset), filtered by the
 * optional status, with id-keyset paging (`id > cursor`). Emits numbered (`$n`) SQL (the knex
 * adapter translates to positional `?` via `numberedToQmark`).
 */
export function buildEndpointListQuery(filter: EndpointListFilter): BuiltQuery {
  const params: unknown[] = [];
  const ph = (): string => `$${String(params.length)}`;
  const conds: string[] = [];
  if (filter.status !== undefined) {
    params.push(filter.status);
    conds.push(`status = ${ph()}`);
  }
  if (filter.cursor !== undefined) {
    params.push(filter.cursor);
    conds.push(`id > ${ph()}`);
  }
  const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
  params.push(clampListLimit(filter.limit));
  const sql = `SELECT ${ENDPOINT_LIST_COLUMNS.join(", ")} FROM ${ENDPOINTS_TABLE} ${where} ORDER BY id ASC LIMIT ${ph()}`;
  return { sql, params };
}

/** Fold a page of outbox list rows into a {@link Page}: map rows, derive `nextCursor` from `seq`. */
export function outboxListPage(
  rows: RawOutboxListRow[],
  limit: number,
): { items: OutboxListItem[]; nextCursor: string | null } {
  const items = rows.map(mapOutboxListItem);
  const nextCursor = items.length === limit ? (items[items.length - 1]?.seq ?? null) : null;
  return { items, nextCursor };
}

/** Fold a page of endpoint summary rows into a {@link Page}: map rows, derive `nextCursor` from `id`. */
export function endpointListPage(
  rows: RawEndpointSummaryRow[],
  limit: number,
): { items: EndpointSummary[]; nextCursor: string | null } {
  const items = rows.map(mapEndpointSummary);
  const nextCursor = items.length === limit ? (items[items.length - 1]?.id ?? null) : null;
  return { items, nextCursor };
}

/** Collect the table names reported present (`true`) by a dialect `diagnoseSql` result row. */
export function existingFromRow(row: Record<string, unknown>): Set<string> {
  const existing = new Set<string>();
  for (const t of ALL_TABLES) {
    if (row[t] === true) existing.add(t);
  }
  return existing;
}

/** Compute the diagnose result from the set of existing table names. */
export function diagnoseResult(existing: ReadonlySet<string>): {
  ok: boolean;
  missingTables: string[];
} {
  const missingTables = ALL_TABLES.filter((t) => !existing.has(t));
  const ok = CORE_TABLES.every((t) => existing.has(t));
  return { ok, missingTables };
}

/** Fold `GROUP BY status` rows into a `Record<Status, number>`, zero-filling missing statuses. */
export function countsFromRows(
  rows: { status: string; count: number | string }[],
): Record<Status, number> {
  const counts = Object.fromEntries(ALL_STATUSES.map((s) => [s, 0])) as Record<Status, number>;
  for (const r of rows) {
    if ((ALL_STATUSES as readonly string[]).includes(r.status)) {
      counts[r.status as Status] = Number(r.count);
    }
  }
  return counts;
}
