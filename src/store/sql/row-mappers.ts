/**
 * Row mapping: the snake_case shapes the driver returns and the camelCase domain objects the Store
 * exposes. The pg driver parses jsonb and timestamptz for us; knex/drizzle on the pg dialect use the
 * same driver. The list shapes are secret-free (no `secret*` columns) so the encrypted-store
 * decorator can pass them through untouched.
 */
import type { OutboxRow, DeliveryAttempt, EndpointRow } from "../../core/index";
import type { OutboxListItem, EndpointSummary } from "../store";

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

export { type RawOutboxRow, type RawAttemptRow, type RawEndpointRow };
export { type RawOutboxListRow, type RawEndpointSummaryRow };
