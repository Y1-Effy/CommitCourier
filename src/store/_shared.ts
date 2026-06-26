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
import type { OutboxRow, DeliveryAttempt, EndpointRow, Transition, Status } from "../core/index";
import type {
  NewOutboxRow,
  NewDeliveryAttempt,
  NewEndpointRow,
  EndpointPatch,
  ReplayFilter,
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
 * outbox id. `numbered` is pg (`$1`…); `qmark` is knex.raw (`?`).
 */
export function completeAttemptSql(
  setColumns: string[],
  placeholder: "numbered" | "qmark",
): string {
  const ph = (n: number): string => (placeholder === "numbered" ? `$${String(n)}` : "?");
  const values = ATTEMPT_COLUMNS.map((c, i) =>
    c === ATTEMPT_JSON_COLUMN ? `${ph(i + 1)}::jsonb` : ph(i + 1),
  );
  // Placeholders follow textual order (attempt values, then SET values, then id) so a single
  // binding order works for both `$n` and positional `?`.
  const setStart = ATTEMPT_COLUMNS.length + 1;
  const set = setColumns.map((c, i) => `${c} = ${ph(setStart + i)}`).join(", ");
  const idPos = setStart + setColumns.length;
  return `WITH ins AS (
  INSERT INTO ${ATTEMPTS_TABLE} (${ATTEMPT_COLUMNS.join(", ")}) VALUES (${values.join(", ")})
)
UPDATE ${OUTBOX_TABLE} SET ${set} WHERE id = ${ph(idPos)} AND status = 'in_flight'`;
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

/** Build the dynamic WHERE for a {@link ReplayFilter}: `{ sql, params }` (empty when no filter). */
export function replayWhere(filter: ReplayFilter): { sql: string; params: unknown[] } {
  const conds: string[] = [];
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
  return { sql: conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "", params };
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
