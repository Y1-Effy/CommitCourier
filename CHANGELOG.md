# Changelog

🇯🇵 日本語版: **[CHANGELOG.ja.md](./CHANGELOG.ja.md)**

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
