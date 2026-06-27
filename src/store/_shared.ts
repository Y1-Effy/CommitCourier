/**
 * Shared plumbing for the relational (SQL) store family — used by the pg and knex adapters.
 *
 * Centralises table/column names, snake_case/camelCase row mapping, INSERT/transition flattening,
 * the diagnose-result computation, and reading the DDL file, so the driver adapters stay thin and
 * cannot drift apart. The Postgres-specific SQL (claim CTE, `to_regclass` probe, DDL script) lives
 * behind the dialect seam in {@link "./sql/dialect"} / {@link "./sql/postgres"}; this module holds
 * only the driver- and dialect-agnostic plumbing.
 */
import initSql from "./sql/001_init.sql";
import sinkTargetlessSql from "./sql/002_sink_targetless.sql";
import type { OutboxRow, DeliveryAttempt, EndpointRow, Transition, Status } from "../core/index";
import type {
  NewOutboxRow,
  NewDeliveryAttempt,
  NewEndpointRow,
  EndpointPatch,
  ReplayFilter,
  OutboxListItem,
  OutboxListFilter,
  EndpointSummary,
  EndpointListFilter,
} from "./store";

/** Re-exported so the pg/knex adapters keep importing `newId` from a single store-local module. */
export { newId } from "../id";

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

// --- Migration tracking. A lightweight version table records which migration
// scripts have been applied, so `migrate()` applies only the not-yet-applied ones in order. v1's
// whole schema is `001_init`; future schema changes append `00N_*` entries to MIGRATIONS. Every
// migration's DDL is itself idempotent (IF NOT EXISTS), so an existing deployment that pre-dates the
// tracking table is brought into line safely: the table is created, `001_init` is seen as unapplied
// and re-run (a no-op against the existing schema), then recorded. ---

export const MIGRATIONS_TABLE = "commitcourier_migrations";

/** Tracking table DDL (idempotent), created before any migration is applied. */
export const MIGRATIONS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
)`;

/**
 * Fixed advisory-lock key (a 32-bit int, "cmig") serialising concurrent `migrate()` calls. Postgres
 * `IF NOT EXISTS` DDL is NOT concurrency-safe — N replicas migrating a fresh schema at once can hit
 * `tuple concurrently updated` / a `pg_type` unique violation / a deadlock. Acquiring this transaction
 * lock first makes the schema-changing statements run one transaction at a time; the loser then finds
 * everything already created/recorded and no-ops.
 */
export const MIGRATION_LOCK_KEY = 0x636d6967;

/**
 * Acquire the migration advisory lock for the current transaction (released on commit/rollback).
 * Run as the first statement of every transaction that creates schema (the tracking table and each
 * migration's apply), so concurrent migrators serialise.
 */
export const ADVISORY_LOCK_SQL = `SELECT pg_advisory_xact_lock(${String(MIGRATION_LOCK_KEY)})`;

/** Read the applied migration names. */
export const SELECT_APPLIED_MIGRATIONS_SQL = `SELECT name FROM ${MIGRATIONS_TABLE}`;

/** One ordered migration: a name plus its idempotent DDL script. */
export interface Migration {
  name: string;
  sql: string;
}

/** A safe migration name (used inline in the record statement); guards against future foot-guns. */
const MIGRATION_NAME_RE = /^[0-9a-z_]+$/;

/** The ordered migration list. Append `00N_*` entries here for future schema changes. */
export const MIGRATIONS: readonly Migration[] = [
  { name: "001_init", sql: initSql },
  // 002: drop the target CHECK so the `sink` transport can enqueue target-less rows.
  { name: "002_sink_targetless", sql: sinkTargetlessSql },
];

/**
 * The tracking-table create as a single multi-statement script that first takes the advisory lock,
 * so concurrent `ensureTable` calls serialise (the multi-statement adapters run this as one implicit
 * transaction). Prisma cannot run a multi-statement string, so it runs the lock + DDL itself inside a
 * `$transaction` (see the prisma adapter); this script is for the pg/knex/drizzle adapters.
 */
export function migrationsTableScript(): string {
  return `${ADVISORY_LOCK_SQL};\n${MIGRATIONS_TABLE_DDL}`;
}

/**
 * Build the apply script for one migration: the advisory lock, then its DDL, then the record INSERT,
 * as a single multi-statement script. Postgres runs a multi-statement simple query as one implicit
 * transaction, so the lock is held through the schema change and the bookkeeping commits atomically
 * (the pg/knex/drizzle adapters run this verbatim; Prisma splits it into per-statement calls inside an
 * explicit transaction, where the lock statement lands first). The name is an internal constant
 * matching {@link MIGRATION_NAME_RE}, so inlining it as a literal is safe.
 */
export function migrationScript(m: Migration): string {
  if (!MIGRATION_NAME_RE.test(m.name)) {
    throw new Error(`invalid migration name: "${m.name}"`);
  }
  const ddl = m.sql.trim().replace(/;\s*$/, "");
  return `${ADVISORY_LOCK_SQL};\n${ddl};\nINSERT INTO ${MIGRATIONS_TABLE} (name) VALUES ('${m.name}') ON CONFLICT (name) DO NOTHING`;
}

/**
 * Split an idempotent DDL/migration script into individual statements for adapters that run one
 * statement per call (Prisma). Line comments (`-- …`) are stripped first so a comment preceding a
 * statement is not mistaken for it (the scripts have no `--`/`;` inside string literals).
 */
export function splitStatements(script: string): string[] {
  const noComments = script
    .split("\n")
    .map((line) => {
      const i = line.indexOf("--");
      return i >= 0 ? line.slice(0, i) : line;
    })
    .join("\n");
  return noComments
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Run the migration protocol against an adapter's primitives: ensure the tracking table, read the
 * applied set, then apply each not-yet-applied migration in order. Idempotent and safe to re-run:
 * each migration's DDL is idempotent, the apply is atomic, and the record uses ON CONFLICT DO NOTHING.
 */
export async function applyMigrations(deps: {
  ensureTable: () => Promise<void>;
  appliedNames: () => Promise<Set<string>>;
  apply: (m: Migration) => Promise<void>;
}): Promise<void> {
  await deps.ensureTable();
  const applied = await deps.appliedNames();
  for (const m of MIGRATIONS) {
    if (!applied.has(m.name)) await deps.apply(m);
  }
}

// --- Row shapes as returned by the driver (snake_case; the pg driver parses jsonb and
// timestamptz for us, and knex on the pg dialect uses the same driver). ---

interface RawOutboxRow {
  id: string;
  event_type: string;
  payload: unknown;
  endpoint_id: string | null;
  target_url: string | null;
  secret_snapshot: string | null;
  status: string;
  attempts: number;
  available_at: Date;
  locked_at: Date | null;
  locked_by: string | null;
  idempotency_key: string | null;
  last_error: string | null;
  created_at: Date;
  dispatched_at: Date | null;
}

interface RawAttemptRow {
  id: string;
  outbox_id: string;
  attempt_no: number;
  request_headers: Record<string, string>;
  response_status: number | null;
  response_body_snippet: string | null;
  duration_ms: number;
  error: string | null;
  attempted_at: Date;
}

interface RawEndpointRow {
  id: string;
  url: string;
  secret: string;
  secret_secondary: string | null;
  status: string;
  description: string | null;
  consecutive_failures: number;
  disabled_at: Date | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}

export function mapOutboxRow(r: RawOutboxRow): OutboxRow {
  return {
    id: r.id,
    eventType: r.event_type,
    payload: r.payload,
    endpointId: r.endpoint_id,
    targetUrl: r.target_url,
    secretSnapshot: r.secret_snapshot,
    status: r.status as OutboxRow["status"],
    attempts: r.attempts,
    availableAt: r.available_at,
    lockedAt: r.locked_at,
    lockedBy: r.locked_by,
    idempotencyKey: r.idempotency_key,
    lastError: r.last_error,
    createdAt: r.created_at,
    dispatchedAt: r.dispatched_at,
  };
}

export function mapAttemptRow(r: RawAttemptRow): DeliveryAttempt {
  return {
    id: r.id,
    outboxId: r.outbox_id,
    attemptNo: r.attempt_no,
    requestHeaders: r.request_headers,
    responseStatus: r.response_status,
    responseBodySnippet: r.response_body_snippet,
    durationMs: r.duration_ms,
    error: r.error,
    attemptedAt: r.attempted_at,
  };
}

export function mapEndpointRow(r: RawEndpointRow): EndpointRow {
  return {
    id: r.id,
    url: r.url,
    secret: r.secret,
    secretSecondary: r.secret_secondary,
    status: r.status as EndpointRow["status"],
    description: r.description,
    consecutiveFailures: r.consecutive_failures,
    disabledAt: r.disabled_at,
    metadata: r.metadata,
    createdAt: r.created_at,
  };
}

export { type RawOutboxRow, type RawAttemptRow, type RawEndpointRow };

// --- INSERT payloads. The pg adapter binds ordered values; knex takes an object and must
// stringify json columns itself (the pg driver auto-serialises objects, but knex does not). ---

/** Outbox columns in INSERT order (shared so the two adapters cannot drift). */
export const OUTBOX_COLUMNS = [
  "id",
  "event_type",
  "payload",
  "endpoint_id",
  "target_url",
  "secret_snapshot",
  "status",
  "attempts",
  "available_at",
  "idempotency_key",
] as const;

/** Ordered values matching {@link OUTBOX_COLUMNS} for a parameterised (pg) INSERT. */
export function outboxValues(row: NewOutboxRow): unknown[] {
  return [
    row.id,
    row.eventType,
    row.payload,
    row.endpointId,
    row.targetUrl,
    row.secretSnapshot,
    row.status,
    row.attempts,
    row.availableAt,
    row.idempotencyKey,
  ];
}

/** Object form for a knex INSERT; `payload` is stringified for the jsonb column. */
export function outboxObject(row: NewOutboxRow): Record<string, unknown> {
  return {
    id: row.id,
    event_type: row.eventType,
    payload: JSON.stringify(row.payload),
    endpoint_id: row.endpointId,
    target_url: row.targetUrl,
    secret_snapshot: row.secretSnapshot,
    status: row.status,
    attempts: row.attempts,
    available_at: row.availableAt,
    idempotency_key: row.idempotencyKey,
  };
}

/** Attempt columns in INSERT order. `id` is generated here; `attempted_at` defaults to now(). */
export const ATTEMPT_COLUMNS = [
  "id",
  "outbox_id",
  "attempt_no",
  "request_headers",
  "response_status",
  "response_body_snippet",
  "duration_ms",
  "error",
] as const;

/** Ordered values matching {@link ATTEMPT_COLUMNS} for a parameterised (pg) INSERT. */
export function attemptValues(id: string, a: NewDeliveryAttempt): unknown[] {
  return [
    id,
    a.outboxId,
    a.attemptNo,
    a.requestHeaders,
    a.responseStatus,
    a.responseBodySnippet,
    a.durationMs,
    a.error,
  ];
}

/** Object form for a knex INSERT; `request_headers` is stringified for the jsonb column. */
export function attemptObject(id: string, a: NewDeliveryAttempt): Record<string, unknown> {
  return {
    id,
    outbox_id: a.outboxId,
    attempt_no: a.attemptNo,
    request_headers: JSON.stringify(a.requestHeaders),
    response_status: a.responseStatus,
    response_body_snippet: a.responseBodySnippet,
    duration_ms: a.durationMs,
    error: a.error,
  };
}

// --- Registered endpoints. INSERT omits status/consecutive_failures/created_at so the DDL
// defaults apply; `metadata` is the jsonb column (handled like `payload`/`request_headers`). ---

/** Endpoint columns in INSERT order. `metadata` is the jsonb column. */
export const ENDPOINT_COLUMNS = ["id", "url", "secret", "description", "metadata"] as const;

/** Ordered values matching {@link ENDPOINT_COLUMNS} for a parameterised (pg) INSERT. */
export function endpointValues(ep: NewEndpointRow): unknown[] {
  return [ep.id, ep.url, ep.secret, ep.description ?? null, ep.metadata ?? null];
}

/** Object form for a knex INSERT; `metadata` is stringified for the jsonb column. */
export function endpointObject(ep: NewEndpointRow): Record<string, unknown> {
  return {
    id: ep.id,
    url: ep.url,
    secret: ep.secret,
    description: ep.description ?? null,
    metadata: ep.metadata != null ? JSON.stringify(ep.metadata) : null,
  };
}

const ENDPOINT_PATCH_COLUMN: Record<keyof EndpointPatch, string> = {
  url: "url",
  secret: "secret",
  secretSecondary: "secret_secondary",
  description: "description",
  metadata: "metadata",
  status: "status",
  disabledAt: "disabled_at",
};

/** The jsonb column among endpoint patch fields (needs `::jsonb` in pg / stringify in knex). */
export const ENDPOINT_JSON_COLUMN = "metadata";

/** Flatten an {@link EndpointPatch} into columns/raw values to SET (undefined keys skipped) — pg. */
export function endpointPatchColumns(patch: EndpointPatch): {
  columns: string[];
  values: unknown[];
} {
  const columns: string[] = [];
  const values: unknown[] = [];
  for (const key of Object.keys(ENDPOINT_PATCH_COLUMN) as (keyof EndpointPatch)[]) {
    if (patch[key] !== undefined) {
      columns.push(ENDPOINT_PATCH_COLUMN[key]);
      values.push(patch[key]);
    }
  }
  return { columns, values };
}

/** Object form of an {@link EndpointPatch} for a knex UPDATE; `metadata` is stringified. */
export function endpointPatchObject(patch: EndpointPatch): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(ENDPOINT_PATCH_COLUMN) as (keyof EndpointPatch)[]) {
    const value = patch[key];
    if (value === undefined) continue;
    const column = ENDPOINT_PATCH_COLUMN[key];
    out[column] = column === ENDPOINT_JSON_COLUMN && value != null ? JSON.stringify(value) : value;
  }
  return out;
}

// --- State transitions. core/state.ts produces a sparse delta; persist only the keys present. ---

const TRANSITION_COLUMN: Record<keyof Transition, string> = {
  status: "status",
  attempts: "attempts",
  availableAt: "available_at",
  lockedAt: "locked_at",
  lockedBy: "locked_by",
  lastError: "last_error",
  dispatchedAt: "dispatched_at",
};

/** Flatten a {@link Transition} into the columns/values to SET (undefined keys are skipped). */
export function transitionColumns(t: Transition): { columns: string[]; values: unknown[] } {
  const columns: string[] = [];
  const values: unknown[] = [];
  for (const key of Object.keys(TRANSITION_COLUMN) as (keyof Transition)[]) {
    const value = t[key];
    if (value !== undefined) {
      columns.push(TRANSITION_COLUMN[key]);
      values.push(value);
    }
  }
  return { columns, values };
}

// --- Combined ledger-append + transition (dispatch hot path). One CTE writes the attempt and
// applies the transition in a single round trip; the UPDATE keeps the in_flight idempotency guard. ---

/** The jsonb column among attempt columns (cast to `::jsonb` like `payload`). */
const ATTEMPT_JSON_COLUMN = "request_headers";

/**
 * Build the `completeAttempt` CTE for the given transition SET columns and placeholder style.
 * Bindings order follows textual order so it works for both `$n` and positional `?`: the
 * {@link ATTEMPT_COLUMNS} values, then the transition values (matching `setColumns`), then the
 * outbox id, then (when `opts.guardLockedBy`) the expected `locked_by`. `numbered` is pg (`$1`…);
 * `qmark` is knex.raw (`?`).
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
  placeholder: "numbered" | "qmark",
  opts: { guardLockedBy?: boolean } = {},
): string {
  const ph = (n: number): string => (placeholder === "numbered" ? `$${String(n)}` : "?");
  const values = ATTEMPT_COLUMNS.map((c, i) =>
    c === ATTEMPT_JSON_COLUMN ? `${ph(i + 1)}::jsonb` : ph(i + 1),
  );
  // Placeholders follow textual order (attempt values, then SET values, then id, then locked_by) so
  // a single binding order works for both `$n` and positional `?`.
  const setStart = ATTEMPT_COLUMNS.length + 1;
  const set = setColumns.map((c, i) => `${c} = ${ph(setStart + i)}`).join(", ");
  const idPos = setStart + setColumns.length;
  const lockGuard = opts.guardLockedBy ? ` AND locked_by = ${ph(idPos + 1)}` : "";
  return `WITH ins AS (
  INSERT INTO ${ATTEMPTS_TABLE} (${ATTEMPT_COLUMNS.join(", ")}) VALUES (${values.join(", ")})
)
UPDATE ${OUTBOX_TABLE} SET ${set} WHERE id = ${ph(idPos)} AND status = 'in_flight'${lockGuard}`;
}

/** Ordered attempt values for a knex.raw bind (jsonb column stringified), matching {@link ATTEMPT_COLUMNS}. */
export function attemptValuesStringified(id: string, a: NewDeliveryAttempt): unknown[] {
  const obj = attemptObject(id, a);
  return ATTEMPT_COLUMNS.map((c) => obj[c]);
}

/** Ordered outbox values with the jsonb `payload` stringified, matching {@link OUTBOX_COLUMNS}. */
export function outboxValuesStringified(row: NewOutboxRow): unknown[] {
  const obj = outboxObject(row);
  return OUTBOX_COLUMNS.map((c) => obj[c]);
}

/** Ordered endpoint values with the jsonb `metadata` stringified, matching {@link ENDPOINT_COLUMNS}. */
export function endpointValuesStringified(ep: NewEndpointRow): unknown[] {
  const obj = endpointObject(ep);
  return ENDPOINT_COLUMNS.map((c) => obj[c]);
}

// --- Numbered-placeholder INSERT / replay SQL builders ($1, $2, …). Shared by the pg and Drizzle
// adapters (both run node-postgres under the hood and bind positional `$n` parameters). ---

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
  return { sql: `WHERE ${conds.join(" AND ")}`, params };
}

// --- v2.1 operability helpers (cancel, circuit breaker, single-row get, replay cap). ---

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
 * Build the circuit-breaker failure UPDATE for either placeholder style: atomically increment
 * `consecutive_failures` and, when the new count reaches the threshold while still `active`, disable
 * the endpoint in the same statement (so the increment and the auto-disable can never diverge under
 * concurrency). Bindings follow textual order so one order works for `$n` and positional `?`: for
 * `numbered`, the threshold reuses `$2` and the order is `[id, threshold, now]`; for `qmark` the
 * threshold value appears twice, so the order is `[threshold, threshold, now, id]`.
 */
export function buildNoteEndpointFailureSql(placeholder: "numbered" | "qmark"): string {
  const id = placeholder === "numbered" ? "$1" : "?";
  const thr = placeholder === "numbered" ? "$2" : "?";
  const now = placeholder === "numbered" ? "$3" : "?";
  // qmark cannot reuse a binding, so the threshold is referenced via two separate `?` placeholders.
  const thr2 = placeholder === "numbered" ? "$2" : "?";
  return `UPDATE ${ENDPOINTS_TABLE} SET consecutive_failures = consecutive_failures + 1, status = CASE WHEN consecutive_failures + 1 >= ${thr} AND status = 'active' THEN 'disabled' ELSE status END, disabled_at = CASE WHEN consecutive_failures + 1 >= ${thr2} AND status = 'active' THEN ${now} ELSE disabled_at END WHERE id = ${id}`;
}

/** Ordered bindings for {@link buildNoteEndpointFailureSql} in the given placeholder style. */
export function noteEndpointFailureParams(
  placeholder: "numbered" | "qmark",
  id: string,
  now: Date,
  threshold: number,
): unknown[] {
  // numbered reuses $2, so it binds each distinct value once; qmark lists the threshold twice.
  return placeholder === "numbered" ? [id, threshold, now] : [threshold, threshold, now, id];
}

/** Default cap on a single `replay` call; the admin layer applies it when no explicit limit is set. */
export const REPLAY_DEFAULT_LIMIT = 1_000;
/** Hard ceiling on one `replay` call so a filter can never fan out into an unbounded mass re-send. */
export const REPLAY_MAX_LIMIT = 10_000;

/** Clamp a requested replay limit into `(0, REPLAY_MAX_LIMIT]`, defaulting when absent/invalid. */
export function clampReplayLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return REPLAY_DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), REPLAY_MAX_LIMIT);
}

// --- Retention / prune. Deletes terminal rows older than a cutoff in bounded batches; ledger
// attempts cascade. The admin layer constrains the statuses to the non-active set below so a
// `pending`/`in_flight` row can never be deleted out from under a delivery. ---

/** Statuses a `prune` is allowed to delete (never `pending`/`in_flight`). */
export const PRUNABLE_STATUSES = ["delivered", "dead", "cancelled", "observed"] as const;
/** Default statuses pruned when the caller does not specify (keeps `observed` for audit). */
export const DEFAULT_PRUNE_STATUSES: Status[] = ["delivered", "dead", "cancelled"];

/** Default rows deleted per `prune` call when the caller omits `limit`. */
export const PRUNE_DEFAULT_LIMIT = 10_000;
/** Hard ceiling on one `prune` batch so a single call cannot delete (and lock) an unbounded set. */
export const PRUNE_MAX_LIMIT = 100_000;

/** Clamp a requested prune limit into `(0, PRUNE_MAX_LIMIT]`, defaulting when absent/invalid. */
export function clampPruneLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return PRUNE_DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), PRUNE_MAX_LIMIT);
}

/**
 * Build the retention DELETE for either placeholder style. A bounded inner SELECT (oldest-first,
 * `LIMIT`) picks the ids to delete so one call never deletes an unbounded set or holds a table-wide
 * lock; the outer DELETE removes them (ledger attempts cascade). The `statusCount` statuses are
 * expanded into individual `IN (...)` placeholders (rather than a bound array) so every driver —
 * including Prisma and knex.raw — binds plain scalars uniformly. Bindings follow textual order so one
 * order works for `$n` and positional `?`: the statuses, then `olderThan`, then `limit`.
 */
export function buildPruneSql(statusCount: number, placeholder: "numbered" | "qmark"): string {
  let n = 0;
  const ph = (): string => (placeholder === "numbered" ? `$${String(++n)}` : (n++, "?"));
  const inList = Array.from({ length: statusCount }, () => ph()).join(", ");
  const olderThan = ph();
  const limit = ph();
  return `DELETE FROM ${OUTBOX_TABLE} WHERE id IN (SELECT id FROM ${OUTBOX_TABLE} WHERE status IN (${inList}) AND created_at < ${olderThan} ORDER BY created_at LIMIT ${limit})`;
}

/** Ordered bindings for {@link buildPruneSql}: the statuses, then `olderThan`, then `limit`. */
export function pruneParams(statuses: Status[], olderThan: Date, limit: number): unknown[] {
  return [...statuses, olderThan, limit];
}

// --- Read-only list/DLQ queries (admin). Both list surfaces are secret-free: the SELECT column
// lists below deliberately omit every secret column, so the encrypted-store decorator can pass the
// rows through untouched (no decryption) and secrets never reach the list API. Keyset pagination
// uses a unique, monotonic column (outbox: `seq`; endpoints: `id`) so paging is stable. ---

/** Default page size for the list APIs when the caller omits `limit`. */
export const LIST_DEFAULT_LIMIT = 50;
/** Hard ceiling on a list page so a caller cannot ask for an unbounded scan. */
export const LIST_MAX_LIMIT = 500;

/** Clamp a requested page size into `(0, LIST_MAX_LIMIT]`, defaulting when absent/invalid. */
export function clampListLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) return LIST_DEFAULT_LIMIT;
  return Math.min(Math.floor(limit), LIST_MAX_LIMIT);
}

/** Secret-free outbox columns (omits `secret_snapshot`), plus `seq` for the keyset cursor. */
export const OUTBOX_LIST_COLUMNS = [
  "id",
  "event_type",
  "payload",
  "endpoint_id",
  "target_url",
  "status",
  "attempts",
  "available_at",
  "locked_at",
  "locked_by",
  "idempotency_key",
  "last_error",
  "created_at",
  "dispatched_at",
  "seq",
] as const;

/**
 * Single-row, secret-free outbox fetch by id (reuses the secret-free list columns, so the
 * encrypted-store decorator passes it through without decryption). One `$1` placeholder; knex
 * builds the equivalent `select(...).where('id', ...)`.
 */
export const GET_OUTBOX_SQL = `SELECT ${OUTBOX_LIST_COLUMNS.join(", ")} FROM ${OUTBOX_TABLE} WHERE id = $1`;

/** Secret-free endpoint columns (omits `secret`/`secret_secondary`). */
export const ENDPOINT_LIST_COLUMNS = [
  "id",
  "url",
  "status",
  "description",
  "consecutive_failures",
  "disabled_at",
  "metadata",
  "created_at",
] as const;

/** Outbox list row as returned by the driver (snake_case, secret-free; `seq` is a bigint). */
interface RawOutboxListRow {
  id: string;
  event_type: string;
  payload: unknown;
  endpoint_id: string | null;
  target_url: string | null;
  status: string;
  attempts: number;
  available_at: Date;
  locked_at: Date | null;
  locked_by: string | null;
  idempotency_key: string | null;
  last_error: string | null;
  created_at: Date;
  dispatched_at: Date | null;
  /** bigint: node-postgres returns it as a string, Prisma as a JS BigInt. */
  seq: string | number | bigint;
}

/** Endpoint summary row as returned by the driver (snake_case, secret-free). */
interface RawEndpointSummaryRow {
  id: string;
  url: string;
  status: string;
  description: string | null;
  consecutive_failures: number;
  disabled_at: Date | null;
  metadata: Record<string, unknown> | null;
  created_at: Date;
}

export function mapOutboxListItem(r: RawOutboxListRow): OutboxListItem {
  return {
    id: r.id,
    eventType: r.event_type,
    payload: r.payload,
    endpointId: r.endpoint_id,
    targetUrl: r.target_url,
    status: r.status as OutboxListItem["status"],
    attempts: r.attempts,
    availableAt: r.available_at,
    lockedAt: r.locked_at,
    lockedBy: r.locked_by,
    idempotencyKey: r.idempotency_key,
    lastError: r.last_error,
    createdAt: r.created_at,
    dispatchedAt: r.dispatched_at,
    // Normalise the bigint cursor to a decimal string across drivers (string | number | BigInt).
    seq: String(r.seq),
  };
}

export function mapEndpointSummary(r: RawEndpointSummaryRow): EndpointSummary {
  return {
    id: r.id,
    url: r.url,
    status: r.status as EndpointSummary["status"],
    description: r.description,
    consecutiveFailures: r.consecutive_failures,
    disabledAt: r.disabled_at,
    metadata: r.metadata,
    createdAt: r.created_at,
  };
}

export { type RawOutboxListRow, type RawEndpointSummaryRow };

/** A built statement with its ordered bindings, for either placeholder convention. */
interface BuiltQuery {
  sql: string;
  params: unknown[];
}

/**
 * Build the secret-free outbox list query for either placeholder style. Newest-first by `seq`
 * (a stable, monotonic keyset), filtered by the optional status/since/endpointId, with seq-keyset
 * paging (`seq < cursor`). The cursor placeholder is cast to `::bigint` so Prisma — which would
 * otherwise infer text — compares it against the bigint column. Bindings follow textual order so a
 * single order works for `$n` and positional `?`.
 */
export function buildOutboxListQuery(
  filter: OutboxListFilter,
  placeholder: "numbered" | "qmark",
): BuiltQuery {
  const params: unknown[] = [];
  const ph = (): string => (placeholder === "numbered" ? `$${String(params.length)}` : "?");
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
 * Build the secret-free endpoint list query for either placeholder style. Ordered by `id`
 * (a unique keyset), filtered by the optional status, with id-keyset paging (`id > cursor`).
 */
export function buildEndpointListQuery(
  filter: EndpointListFilter,
  placeholder: "numbered" | "qmark",
): BuiltQuery {
  const params: unknown[] = [];
  const ph = (): string => (placeholder === "numbered" ? `$${String(params.length)}` : "?");
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

// --- Diagnose-result computation. The dialect supplies the existence-probe SQL (see
// `./sql/postgres` `diagnoseSql`); these helpers interpret its result row, dialect-agnostically. ---

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

// --- Stats. The adapter runs a `GROUP BY status` count; this folds the rows into a fully
// zero-filled, dialect-agnostic shape (pg/knex return count() as a bigint string). ---

/** Every lifecycle status, used to zero-fill {@link OutboxStats.counts} (mirrors the DDL CHECK). */
export const ALL_STATUSES = [
  "pending",
  "in_flight",
  "delivered",
  "dead",
  "observed",
  "cancelled",
] as const satisfies readonly Status[];

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
