/**
 * Driver-agnostic helpers shared by the pg and knex adapters (per 02-store section 3 note).
 *
 * Centralises table/column names, snake_case/camelCase row mapping, the claim SQL
 * (so both adapters keep identical semantics), and reading the DDL file. Keeping this in one
 * place prevents the two adapters from drifting apart.
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { OutboxRow, DeliveryAttempt, EndpointRow, Transition } from "../core/index";
import type { NewOutboxRow, NewDeliveryAttempt } from "./store";

export const OUTBOX_TABLE = "webhook_outbox";
export const ATTEMPTS_TABLE = "webhook_delivery_attempts";
export const ENDPOINTS_TABLE = "webhook_endpoints";

/** Tables whose absence makes the store non-functional (diagnose reports ok:false). */
export const CORE_TABLES = [OUTBOX_TABLE, ATTEMPTS_TABLE] as const;
/** All tables, including the optional registered-endpoint table. */
export const ALL_TABLES = [OUTBOX_TABLE, ATTEMPTS_TABLE, ENDPOINTS_TABLE] as const;

/** Generate a fresh uuid for rows the DB does not default (e.g. delivery attempts). */
export function newId(): string {
  return randomUUID();
}

/** Read the canonical DDL. Resolves relative to this module (copied into dist by tsup). */
export function loadInitSql(): string {
  return readFileSync(new URL("./sql/001_init.sql", import.meta.url), "utf8");
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

// --- Claim query (02-store section 6). One CTE: SELECT ... FOR UPDATE SKIP LOCKED, then
// UPDATE to in_flight, RETURNING the claimed rows. Built once so pg/knex share semantics. ---

interface ClaimPlaceholders {
  now: string;
  limit: string;
  nowSet: string;
  lockedBy: string;
}

function buildClaimSql(p: ClaimPlaceholders): string {
  return `WITH due AS (
  SELECT id FROM ${OUTBOX_TABLE}
  WHERE status = 'pending' AND available_at <= ${p.now}
  ORDER BY available_at
  FOR UPDATE SKIP LOCKED
  LIMIT ${p.limit}
)
UPDATE ${OUTBOX_TABLE} o
SET status = 'in_flight', locked_at = ${p.nowSet}, locked_by = ${p.lockedBy}
FROM due
WHERE o.id = due.id
RETURNING o.*`;
}

/** pg variant: bindings are `[now, limit, lockedBy]` ($1 is reused for both `now` slots). */
export const CLAIM_SQL_PG = buildClaimSql({ now: "$1", limit: "$2", nowSet: "$1", lockedBy: "$3" });
/** knex.raw variant: positional `?`, so bindings are `[now, limit, now, lockedBy]`. */
export const CLAIM_SQL_KNEX = buildClaimSql({ now: "?", limit: "?", nowSet: "?", lockedBy: "?" });

/**
 * Existence probe for {@link diagnoseResult}. `to_regclass` resolves names through the current
 * `search_path`, exactly as migrate()'s unqualified DDL does, so diagnose stays consistent with
 * where the tables were actually created (no hard-coded `public` assumption, no array param).
 */
export const DIAGNOSE_SQL = `SELECT
  to_regclass('${OUTBOX_TABLE}')    IS NOT NULL AS ${OUTBOX_TABLE},
  to_regclass('${ATTEMPTS_TABLE}')  IS NOT NULL AS ${ATTEMPTS_TABLE},
  to_regclass('${ENDPOINTS_TABLE}') IS NOT NULL AS ${ENDPOINTS_TABLE}`;

/** Collect the table names reported present (`true`) by a {@link DIAGNOSE_SQL} result row. */
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
