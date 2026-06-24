# Changelog

🇯🇵 日本語版: **[CHANGELOG.ja.md](./CHANGELOG.ja.md)**

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `MISSING_SECRET` to the public `RelayErrorCode` union: an inline destination with no stored
  secret snapshot is now reported with a documented, machine-readable code.
- TSDoc for the `postgresStore` and `knexStore` factories describing their transaction binding.

### Changed

- Internal: delivery-path error summarisation is unified in `src/delivery/_error.ts`
  (`errorCode` / `secretFreeSummary`), keeping the secret-free guarantee in one place.

### Fixed

- The `pg` adapter no longer lets a failing `ROLLBACK` mask the original error after a failed
  `COMMIT`.

## [0.0.0] - 2026-06-25

Pre-release. Initial public surface: transactional `enqueue`, background dispatcher with
Standard Webhooks signing, retries, DLQ, delivery ledger, SSRF protection, single-delivery via
`FOR UPDATE SKIP LOCKED`, and `pg` + Knex store adapters.

> ⚠️ Pre-`1.0.0`: the API and package name may still change.

[Unreleased]: https://github.com/Y1-Effy/CommitCourier/compare/v0.0.0...HEAD
[0.0.0]: https://github.com/Y1-Effy/CommitCourier/releases/tag/v0.0.0
