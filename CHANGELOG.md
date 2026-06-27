# Changelog

🇯🇵 日本語版: **[CHANGELOG.ja.md](./CHANGELOG.ja.md)**

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Low-latency delivery accelerator (v2):** an optional, fail-open wake seam. `createRelay({ accelerator })`
  signals the accelerator after each enqueue and subscribes every dispatcher it creates, so a freshly
  enqueued row is delivered near-immediately instead of after the poll interval. The first
  implementation, `createPgAccelerator` from `commitcourier/accelerator/pg`, uses Postgres
  LISTEN/NOTIFY: the `NOTIFY` rides the enqueue transaction (delivered on COMMIT, never before the row
  is visible) and a dedicated, self-healing LISTEN connection cuts the dispatcher's idle backoff short.
  The outbox row stays the single source of truth — a missed wake only delays delivery, never loses it
  (the poller reclaims it). The generic `Accelerator` seam is dependency-free; a BullMQ accelerator is a
  planned future adapter on the same seam.
- **Schema migration version table (v2):** `migrate()` now records applied migrations in a
  `commitcourier_migrations` table and applies only the not-yet-applied ones in order (still idempotent,
  and safe on deployments that pre-date the table). This replaces the single-file apply across all four
  adapters and prepares the ground for incremental `00N_*` schema changes.
- **Read-only DLQ / outbox list API (v1.2):** `relay.list({ status, since, endpointId, limit, cursor })`
  pages outbox rows newest-first by a monotonic `seq`, for DLQ inspection and monitoring. Rows are
  secret-free (the signing-key snapshot is never selected) and paging is seq-keyset (`nextCursor`).
- **Endpoint listing (v1.2):** `endpoints.list({ status, limit, cursor })` returns secret-free endpoint
  summaries (no `secret`/`secret_secondary`), id-keyset paged. Both list methods are implemented across
  all four adapters (`pg`/`knex`/`drizzle`/`prisma`). List filters are validated up front, so a malformed
  `cursor`/`status` fails as a new `INVALID_ARGUMENT` `RelayError` instead of a raw Postgres cast error.
- **OpenTelemetry adapter (v1.2):** `commitcourier/otel` exports `createOtelInstrumentation({ tracer, meter })`,
  returning `{ instrument, hooks }` to pass to `createRelay`. Each delivery attempt emits one CLIENT span
  with secret-free attributes; the outcome updates a `commitcourier.deliveries` counter
  (`outcome = delivered | retry | dead`) and a `commitcourier.delivery.duration` histogram.
  `@opentelemetry/api` is an optional peer; the seam itself (`RelayInit.instrument` + secret-free
  `DeliveryStart`/`DeliveryEvent` carrying `endpointId`/`host`) is dependency-free and fail-open.
- **Key rotation / dual signing (v1.1):** during a rotation, deliveries to a registered endpoint are
  signed with both the current and previous keys (Standard Webhooks space-separated `v1,…` signatures),
  so a receiver on either key verifies. New admin ops `endpoints.rotateSecret(id, newSecret)` and
  `endpoints.finalizeRotation(id)`, backed by a new `secret_secondary` column (added via idempotent
  migration; encrypted at rest when a `cipher` is configured).
- **`Retry-After` support (v1.1):** a retryable response carrying `Retry-After` (delta-seconds or
  HTTP-date) schedules the next attempt at `max(backoff, Retry-After)`, clamped to `retry.capMs`.
- **Immediate `410 Gone` invalidation (v1.1):** a `410` response moves the row straight to `dead`
  without consuming the retry budget and disables the registered endpoint.
- **Opt-in per-endpoint FIFO (v1.1):** `createDispatcher({ ordering: "per-endpoint" })` delivers each
  registered endpoint's rows strictly in arrival order (one in-flight per endpoint); the default
  (`"none"`) stays unordered and fully concurrent. Inline destinations are unaffected. Ordering uses a
  monotonic insertion sequence (`webhook_outbox.seq`), so events enqueued together in one transaction
  (a bulk/same-TX enqueue) are still delivered in insertion order.
- **Drizzle adapter (v1.1):** `drizzleStore` exported from `commitcourier/store/drizzle`, reusing the
  same Postgres dialect and contract as the `pg`/`knex` adapters. `drizzle-orm` is an optional peer.
- **Prisma adapter (v1.1):** `prismaStore` exported from `commitcourier/store/prisma`, raw-SQL based
  (reusing the same dialect/contract); enqueue rides the caller's `prisma.$transaction`. `@prisma/client`
  is an optional peer; Prisma is typed structurally so the library builds without it.
- Optional at-rest encryption for signing secrets: `createAesGcmCipher` (WebCrypto AES-256-GCM),
  the `SecretCipher` interface, and `generateSecretKey`, wired through `createRelay({ cipher })`.
  Secrets are stored as a versioned `ccsec.v1.` ciphertext envelope and decrypted only in memory.
- An optional in-process registered-endpoint cache via `RelayInit.endpointCacheTtlMs`, removing the
  per-delivery `findEndpoint` round trip on the registered-endpoint hot path.
- `delivery.keepAliveTimeoutMs` (default 10s) and `delivery.connections` for tuning undici connection
  reuse on the delivery client.

### Changed

- The dispatch claim and reclaim queries now use partial indexes over only the `pending` /
  `in_flight` rows, so they stay fast as delivered/dead rows accumulate.
- The dispatcher's idle wait now backs off adaptively from ~50ms up to `pollIntervalMs`, lowering the
  latency of the first delivery after an idle period.

### Fixed

- Integration tests no longer skip on Windows Docker Desktop: the Docker probe falls back to the
  Docker CLI instead of relying on a named pipe that `existsSync` cannot detect.

## [0.1.0] - 2026-06-25

Initial public release.

### Added

- Transactional `enqueue` that rides the caller's DB transaction, a background dispatcher with
  Standard Webhooks signing, retries with exponential backoff + jitter, a DLQ, a full delivery
  ledger, SSRF protection (on by default), single-delivery across instances via
  `FOR UPDATE SKIP LOCKED`, and `pg` + Knex store adapters.
- `MISSING_SECRET` in the public `RelayErrorCode` union for an inline destination with no stored
  secret snapshot.
- `Dispatcher` and `DispatcherOptions` are exported from the package entry point so consumers can
  type the dispatcher.
- TSDoc for the `postgresStore` and `knexStore` factories describing their transaction binding.

### Fixed

- The `pg` adapter no longer lets a failing `ROLLBACK` mask the original error after a failed
  `COMMIT`.

> ⚠️ Pre-`1.0.0`: the API and package name may still change.

[Unreleased]: https://github.com/Y1-Effy/CommitCourier/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Y1-Effy/CommitCourier/releases/tag/v0.1.0
