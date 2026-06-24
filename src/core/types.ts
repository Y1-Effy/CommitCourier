/**
 * Domain types shared across modules (per 01-core section 2).
 *
 * These are pure data shapes with no behaviour. State transitions live in
 * {@link "./state"}, validation in {@link "./config"}.
 */
import type { Clock, Logger, Status, Mode } from "./shared";

/** A single Outbox row (1:1 with basic design section 6.1). */
export interface OutboxRow {
  /** uuid. Also used as the signature `webhook-id`. */
  id: string;
  /** e.g. `"order.created"`. */
  eventType: string;
  /** jsonb payload. */
  payload: unknown;
  endpointId: string | null;
  /** Inline destination, when not using a registered endpoint. */
  targetUrl: string | null;
  /** Signing-key snapshot taken at enqueue time. */
  secretSnapshot: string | null;
  status: Status;
  attempts: number;
  availableAt: Date;
  lockedAt: Date | null;
  lockedBy: string | null;
  idempotencyKey: string | null;
  lastError: string | null;
  createdAt: Date;
  dispatchedAt: Date | null;
}

/** enqueue input (basic design section 9). Either `url` or `endpointId` is required. */
export interface EnqueueInput {
  eventType: string;
  payload: unknown;
  endpoint: { url: string; secret: string } | { endpointId: string };
  idempotencyKey?: string;
}

/** A single delivery-ledger row (basic design section 6.2). */
export interface DeliveryAttempt {
  id: string;
  outboxId: string;
  attemptNo: number;
  /** Request headers sent; never includes the secret itself. */
  requestHeaders: Record<string, string>;
  responseStatus: number | null;
  responseBodySnippet: string | null;
  durationMs: number;
  error: string | null;
  attemptedAt: Date;
}

/** A registered endpoint row (basic design section 6.3). Optional registered-endpoint workflow. */
export interface EndpointRow {
  id: string;
  url: string;
  /** Signing secret. At-rest encryption is the DB's responsibility (encrypted-column support is future). */
  secret: string;
  status: "active" | "disabled";
  description: string | null;
  /** Auto-disable counter; only the registered-endpoint workflow tracks this. */
  consecutiveFailures: number;
  disabledAt: Date | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

/** Retry/backoff policy (basic design section 10). */
export interface RetryConfig {
  maxAttempts: number;
  backoff: "exponential";
  baseMs: number;
  capMs: number;
  /** Jitter fraction in the range 0..1. */
  jitter: number;
}

/** HTTP delivery policy (basic design section 9). */
export interface DeliveryConfig {
  timeoutMs: number;
  bodySnippetBytes: number;
}

/** SSRF guard policy (basic design section 12). */
export interface SsrfConfig {
  blockPrivateRanges: boolean;
  allowlist: string[];
  blocklist: string[];
}

/** Signature scheme (basic design section 11). Only Standard Webhooks is supported. */
export interface SigningConfig {
  scheme: "standard-webhooks";
}

/** Fully-resolved relay configuration (output of {@link "./config".resolveConfig}). */
export interface RelayConfig {
  mode: Mode;
  signing: SigningConfig;
  retry: RetryConfig;
  delivery: DeliveryConfig;
  ssrf: SsrfConfig;
  /** Defaults to `() => new Date()`. */
  clock: Clock;
  /** Defaults to a no-op logger. */
  logger: Logger;
}
