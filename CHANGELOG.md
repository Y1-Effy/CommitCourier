# Changelog

🇯🇵 日本語版: **[CHANGELOG.ja.md](./CHANGELOG.ja.md)**

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
