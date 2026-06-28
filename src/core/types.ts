/**
 * Domain types shared across modules.
 *
 * These are pure data shapes with no behaviour. State transitions live in
 * {@link "./state"}, validation in {@link "./config"}.
 */
import type { Clock, Logger, Status, Mode } from "./shared";

/** A single Outbox row. */
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
  /**
   * Signing-key snapshot taken at enqueue time. Plaintext at this boundary; encrypted at rest
   * when a `cipher` is configured on the relay (see {@link createAesGcmCipher}).
   */
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

/** enqueue input. */
export interface EnqueueInput {
  eventType: string;
  payload: unknown;
  /**
   * Per-event destination. Required for the `http` transport (inline `{ url, secret }` or a registered
   * `{ endpointId }`). Omit for the `sink` transport: the destination is the
   * configured sink/SaaS, so the row carries no per-event target. In `sink` mode any `endpoint` passed
   * here is ignored (and a stray `secret` would be stored unused), so omit it.
   */
  endpoint?: { url: string; secret: string } | { endpointId: string };
  idempotencyKey?: string;
}

/** A single delivery-ledger row. */
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

/** A registered endpoint row. Optional registered-endpoint workflow. */
export interface EndpointRow {
  id: string;
  url: string;
  /**
   * Signing secret. Plaintext at this boundary; encrypted at rest when a `cipher` is configured on
   * the relay (see {@link createAesGcmCipher}), otherwise at-rest encryption is the DB's responsibility.
   */
  secret: string;
  /**
   * Optional secondary signing secret, set during a key rotation so deliveries are dual-signed with
   * both keys (see the delivery module). Null outside a rotation. Encrypted at rest when a `cipher`
   * is configured, exactly like {@link EndpointRow.secret}.
   */
  secretSecondary: string | null;
  status: "active" | "disabled";
  description: string | null;
  /** Auto-disable counter; only the registered-endpoint workflow tracks this. */
  consecutiveFailures: number;
  disabledAt: Date | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

/** Retry/backoff policy. */
export interface RetryConfig {
  maxAttempts: number;
  backoff: "exponential";
  baseMs: number;
  capMs: number;
  /** Jitter fraction in the range 0..1. */
  jitter: number;
}

/** HTTP delivery policy. */
export interface DeliveryConfig {
  /**
   * Delivery transport. `"http"` (default) delivers directly: CommitCourier
   * signs, applies SSRF protection and the circuit breaker. `"sink"` hands each event off to a `Sink`
   * (e.g. a webhook-delivery SaaS) instead — signing/SSRF/circuit breaker are then delegated and not
   * applied by CommitCourier. Relay-wide: a single relay cannot mix `http` and `sink`.
   *
   * The `"sink"` transport is experimental and may change in a minor release.
   */
  transport: "http" | "sink";
  timeoutMs: number;
  bodySnippetBytes: number;
  /**
   * How long an idle keep-alive connection is kept open for reuse, in ms (undici `keepAliveTimeout`).
   * Longer windows reuse TCP/TLS across bursts of deliveries to the same host. Defaults to 10_000.
   */
  keepAliveTimeoutMs: number;
  /**
   * Optional cap on simultaneous connections per origin (undici `connections`). Bounds resource use
   * under heavy fan-out to a single host. Left to the undici default (unbounded) when omitted.
   */
  connections?: number;
}

/** SSRF guard policy. */
export interface SsrfConfig {
  blockPrivateRanges: boolean;
  allowlist: readonly string[];
  blocklist: readonly string[];
}

/** Signature scheme. Only Standard Webhooks is supported. */
export interface SigningConfig {
  scheme: "standard-webhooks";
}

/** Registered-endpoint circuit breaker (auto-disable on repeated delivery failure). */
export interface CircuitBreakerConfig {
  /**
   * Consecutive failed deliveries to a registered endpoint before it is auto-disabled. A successful
   * delivery resets the counter. `0` (the default) disables the feature entirely, so a permanently
   * down endpoint never auto-disables. Only the registered-endpoint workflow is affected; inline
   * `{ url, secret }` deliveries have no endpoint to disable.
   */
  failureThreshold: number;
  /**
   * Auto-recovery cooldown in milliseconds (half-open). After an endpoint has been disabled for at
   * least this long (measured from `disabled_at`), the dispatcher lets a trial delivery through:
   * success re-activates the endpoint and resets the counter; failure re-arms the cooldown so the next
   * trial waits another `cooldownMs`. `0` (the default) disables auto-recovery, so a disabled endpoint
   * stays down until an admin calls `endpoints.enable`. Applies to any disabled registered endpoint
   * (whether disabled by the breaker or a `410 Gone`).
   *
   * Trial concurrency depends on the dispatcher's `ordering`: with `"per-endpoint"` (and a single
   * dispatcher instance) exactly one trial is admitted per endpoint, strictly serialised. With the
   * default `"none"` ordering, all of that endpoint's currently-due `pending` rows are admitted as
   * trials at once, so a still-fragile endpoint can see a burst on recovery. Use `"per-endpoint"`
   * ordering if you need the trial to be a single probe.
   */
  cooldownMs: number;
}

/** Fully-resolved relay configuration (output of {@link resolveConfig}). */
export interface RelayConfig {
  mode: Mode;
  signing: SigningConfig;
  retry: RetryConfig;
  delivery: DeliveryConfig;
  ssrf: SsrfConfig;
  /** Registered-endpoint auto-disable policy. `failureThreshold: 0` (default) disables it. */
  circuitBreaker: CircuitBreakerConfig;
  /**
   * Optional ceiling on the UTF-8 byte length of an enqueued payload's JSON serialization. When set,
   * `enqueue`/`enqueueMany`/`enqueueUnsafe` reject an over-size payload with
   * `RelayError("ENQUEUE_INVALID_PAYLOAD")` before it reaches the database. Omitted (the default) =
   * no limit. Serializability (circular references, BigInt, etc.) is always validated regardless.
   */
  maxPayloadBytes?: number;
  /** Defaults to `() => new Date()`. */
  clock: Clock;
  /** Defaults to a no-op logger. */
  logger: Logger;
}
