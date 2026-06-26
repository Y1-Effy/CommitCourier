# Changelog

🇯🇵 日本語版: **[CHANGELOG.ja.md](./CHANGELOG.ja.md)**

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
