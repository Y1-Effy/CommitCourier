# Changelog

🇯🇵 日本語版: **[CHANGELOG.ja.md](./CHANGELOG.ja.md)**

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Per-endpoint custom HTTP headers.** `relay.endpoints.register` / `relay.endpoints.update` now take
  `customHeaders`, sent on every delivery to that endpoint in addition to the signature headers — for
  receivers that need their own auth on top of the signature (an API gateway wanting `x-api-key`, an
  ingress wanting `authorization: Bearer …`). Read them back with `relay.endpoints.get`.
  - **Values are treated as secrets.** They are encrypted at rest when a `cipher` is configured —
    per value, so header _names_ stay readable in the database and an operator can still see which
    headers an endpoint sends. Without a `cipher` they are plaintext, like `secret`, and the existing
    startup PLAINTEXT warning covers them.
  - **Redacted from the delivery ledger.** `webhook_delivery_attempts.request_headers` keeps every
    header _name_ but records each custom value as `[redacted]`, so a failed delivery stays debuggable
    without archiving the credential.
  - **Custom headers are NOT covered by the webhook signature**, which spans `id.timestamp.body` only
    (Standard Webhooks). A receiver cannot infer a header's authenticity from it.
  - **Validated fail-closed at registration** (`INVALID_ARGUMENT`), never silently dropped at delivery:
    the `webhook-*` namespace, `content-type`, `idempotency-key` and hop-by-hop/framing headers are
    reserved; CR/LF, NUL, control and non-ASCII characters in a value are rejected (header injection);
    empty values and surrounding whitespace are rejected rather than trimmed; names are lowercased and
    a collision between two spellings is rejected; the map is capped at 16 entries / 8 KiB.
  - Not available under `delivery.transport: "sink"`, where the sink/SaaS builds the request:
    `register` / `update` throw `CONFIG_INVALID`. Existing rows are not rejected, so a staged
    http → sink migration is not blocked by leftovers.
  - Not exposed on `relay.endpoints.list` / `EndpointSummary`, which stay secret-free by construction.
  - New: `EndpointRow.customHeaders`, plus `customHeaders` on `RegisterEndpointInput` /
    `NewEndpointRow` / `EndpointPatch`. Adds migration `004_endpoint_custom_headers`
    (`webhook_endpoints.custom_headers jsonb`) — run `store.migrate()`.

## [0.4.0] - 2026-07-14

### Fixed

- **Webhook delivery failed with `ERR_INVALID_IP_ADDRESS` under Node 20+ network-family autoselection.**
  Node 20+ enables `autoSelectFamily` by default, which calls the SSRF-guarded `connect.lookup` with
  `all: true` and expects an address array; the guard previously always returned a single address, so
  Node threw `ERR_INVALID_IP_ADDRESS` and every delivery to a hostname target went to the DLQ (the
  workaround was to launch with `--no-network-family-autoselection`). The guarded lookup now honours
  both lookup contracts, so delivery works with or without the flag. SSRF protection is unchanged: a
  resolution set containing any private / loopback / link-local / metadata address is still rejected.
- **A jsonb payload with a top-level `null`, string, or array was rejected on the `pg` and Drizzle
  adapters — inside the fail-closed enqueue transaction.** `validatePayload` permits any JSON value, but
  those two adapters bound jsonb params through node-postgres' native encoding, which maps a JS `null`
  to SQL NULL and mis-encodes a top-level JSON string/array, so such a payload hit the `NOT NULL`
  column / `::jsonb` cast and rolled back the caller's business write. All four adapters (`pg`, Knex,
  Drizzle, Prisma) now pre-stringify jsonb params against the `::jsonb` cast, so every JSON payload
  round-trips identically on every adapter.
- **The registered-endpoint cache (`endpointCacheTtlMs`) could cache a stale endpoint row.** A
  `findEndpoint` that started concurrently with an `update` / `disable` / breaker change could observe
  the pre-write row and cache it for the full TTL. The cache now brackets each write with a generation
  counter and only caches a read whose generation is unchanged, so a value read during a write is never
  cached.
- **`dispatcher.runOnce` / `relay.dispatchOnce` could hold up to ~2× `batchSize` rows in flight.** It
  now subtracts the still-in-flight rows before each claim so the claimed-but-unfinished buffer never
  exceeds `batchSize` (matching the continuous loop), keeping the worst-case in-flight time within what
  the reclaim-safety warning models.
- **A throwing injected `logger` could stall the dispatcher.** Every library log site sits on a
  fail-open path, but the injected logger was the one component still called unguarded, so a logger
  whose method throws could reject a delivery promise and stop the loop. `resolveConfig` now wraps the
  logger fail-open (a throwing method degrades to a no-op; call arity is preserved).
- **`store.prune` now guards against deleting live rows even on a direct store call.** The admin layer
  already validated statuses and clamped the limit, but a direct `Store.prune` caller could delete
  `pending` / `in_flight` rows or issue an unbounded DELETE; the prune SQL now carries an always-on
  `status NOT IN ('pending','in_flight')` guard and clamps the batch size itself (defence in depth,
  mirroring `replay`).

### Changed

- **Delivery pins undici's `autoSelectFamily` on.** Webhook delivery now keeps its IPv4/IPv6
  (Happy-Eyeballs) fallback regardless of the host process's network-family-autoselection setting, so
  a deployment launched with `--no-network-family-autoselection` no longer risks a failed connect to a
  dual-stack host whose DNS returns an unreachable address family first.
- **`createRelay` fails fast when the runtime lacks WebCrypto.** Signing requires the WebCrypto API
  (`globalThis.crypto.subtle`), a standard global on Node 20+ (this package targets 22.19+). On a
  runtime that does not expose it, `createRelay` now throws a clear `RelayError("CONFIG_INVALID")` at
  startup instead of surfacing a cryptic per-delivery `ReferenceError` that — under fail-open delivery
  — would silently fill the DLQ. The `sink` transport delegates signing, so it is exempt.
- **A manual `endpoints.disable()` is now sticky.** It clears `disabled_at` (the circuit-breaker
  cooldown anchor), so a deliberately-disabled endpoint is never brought back by a half-open trial when
  `circuitBreaker.cooldownMs > 0`; it stays disabled until `endpoints.enable()`. Circuit-breaker and
  `410 Gone` auto-disables still stamp `disabled_at = now` and remain recoverable, so only a deliberate
  disable changes behaviour.
- **An undecryptable row quarantined by the encrypted store now surfaces as a data-loss event.** When a
  row reaches the DLQ because its at-rest secret cannot be decrypted (key misconfiguration / corruption),
  it is reported through the critical logger — which falls back to the console when no logger is
  configured — like the delivery path's dead-letter alarm, instead of only a plain `logger.warn`.

### Performance

- **SSRF checks and hot-path encoding do less work per delivery.** The blocked-range table used by the
  SSRF guard is now parsed once at module load instead of on every check (it previously ran up to ~26 IP
  re-parses per resolved address, per delivery), and enqueue payload sizing / response-snippet decoding
  reuse the shared `TextEncoder` / `TextDecoder` instead of allocating one per call. Behaviour is unchanged.
- **New partial indexes speed up the admin list and retention prune on large tables (migration `003`).**
  `relay.list(...)` (DLQ / status-filtered, seq-keyset paging) and `relay.prune(...)` (oldest terminal
  rows, `created_at`-ordered) previously degraded to a full scan + sort on a large, aged outbox. `003`
  adds `ix_outbox_terminal_seq (status, seq)` and `ix_outbox_prune (created_at)`, both PARTIAL on the
  terminal status set so the fail-closed enqueue INSERT path does not maintain them. `migrate()` applies
  it automatically; on a very large existing table it runs a plain (table-locking) `CREATE INDEX`, so an
  operator may instead pre-build the same-named index with `CREATE INDEX CONCURRENTLY` before migrating,
  after which the migration no-ops.

## [0.3.0] - 2026-06-28

### Added

- **Enqueue payload validation:** `enqueue` / `enqueueMany` / `enqueueUnsafe` now reject a payload that
  cannot be stored as `jsonb` — a circular reference, a `BigInt`, or a value that serializes to
  `undefined` — with a stable `RelayError("ENQUEUE_INVALID_PAYLOAD")` instead of leaking a raw driver
  error into your business transaction (symmetric to how the missing-endpoint case is already
  `ENQUEUE_NO_TARGET`). An optional `createRelay({ maxPayloadBytes })` (off by default) additionally
  caps the serialized payload's UTF-8 byte length. Exposed as the pure helper `validatePayload` from
  `commitcourier/core`.

### Changed

- **`Store` decomposed into capability roles (additive, non-breaking).** The single ~25-method
  `Store<TTx>` port is now the composition of seven focused role interfaces —
  `OutboxEnqueueStore<TTx>`, `DispatchStore`, `EndpointStore`, `OutboxQueryStore`, `ReplayStore`,
  `MaintenanceStore`, and `SchemaStore` — each documenting its own atomicity/transaction contract.
  `Store` still extends all of them, so the bundled `pg` / Knex / Drizzle / Prisma adapters and any
  existing `Store` implementation are unchanged. Internally, each consumer now depends only on the
  role it uses (e.g. the dispatcher on `DispatchStore`), and the roles are exported from
  `commitcourier` so a third-party adapter author can see which methods belong to which concern.
- **All four relational adapters de-duplicated behind a shared SQL store (internal, no behavior change).**
  The `pg`, Drizzle, Prisma and Knex adapters previously each re-implemented the same Postgres SQL
  (~300 lines apiece). That logic now lives once in an internal `createSqlStore` over a thin
  per-adapter `SqlExecutor` seam (query / execute / insert-on-tx / withTx), so a new Store method is
  written in one place instead of four. Knex binds positional `?` rather than `$n`, so it translates
  the shared numbered SQL with a small `numberedToQmark` helper just before `knex.raw` (its
  query-builder implementation is gone); the four adapters dropped from ~1310 to ~360 lines combined.
  The SQL is effectively unchanged and the full integration / concurrency / fault suites pass against
  Postgres 12/16/17. Separately, the shared `_shared.ts` plumbing was split by concern into
  `store/sql/{constants,migrations,row-mappers,columns,query-builders,placeholders}.ts` (re-exported
  from `_shared.ts`, so every import is unchanged). No public API change.

### Documentation

- Quick start now injects `createConsoleLogger()` from the outset, so the default no-op logger does not
  silently swallow routine delivery failures and retries.
- Migrations: documented that building an index on an already-large `webhook_outbox` takes a write lock
  (`migrate()` uses a plain `CREATE INDEX`, not `CONCURRENTLY`), with guidance for large existing databases.
- Accelerator: documented the idle polling cost of many always-on dispatchers and pairing the accelerator
  with a longer `pollIntervalMs`.

## [0.2.0] - 2026-06-28

First public release to npm. (Supersedes the unpublished 0.1.0 development baseline below.)

### Added

- **SaaS handoff via the `sink` transport (experimental):** `createRelay({ delivery: { transport: "sink" }, sink })`
  hands each event to a `Sink` (e.g. a webhook-delivery SaaS such as Svix) at least once instead of delivering over
  HTTP directly, so the at-least-once handoff still rides your transaction while final delivery/signing is delegated.
  The `Sink` port and types ship from `commitcourier/forward`, with an official Svix sample adapter at
  `commitcourier/forward/svix` (`svix` is an optional peer). **Experimental: this API may change in a minor release.**
- **Receiver-side `verifySignature` (DX):** a pure, dependency-free helper in `commitcourier/core` that verifies
  an inbound Standard Webhooks request — the counterpart of `sign`. It recomputes the `v1,<base64>` HMAC over
  `{id}.{timestamp}.{payload}` and constant-time compares it against every token in `webhook-signature`, accepts
  multiple `secrets` (so a receiver verifies either key across a rotation), and checks the timestamp against a
  tolerance (default `300`s). Returns `false` (never throws) for a stale timestamp, garbled signature, or no match,
  so any non-`true` is a reject. Removes the need to add a separate verification dependency for internal webhooks.
- **`createConsoleLogger()` (DX):** a ready-made `Logger` (exported from `commitcourier` and `commitcourier/core`)
  so a relay is a one-liner away from being observable instead of silent. Relatedly, `createRelay` now prints a
  one-time startup warning when no `logger` is configured, since the fail-open dispatch path otherwise swallows
  every delivery failure, DLQ transition and SSRF block.
- **Circuit-breaker auto-recovery (half-open):** `createRelay({ circuitBreaker: { cooldownMs: N } })` (default `0`
  = off) lets a disabled endpoint heal on its own. After it has been disabled for at least `cooldownMs` (from
  `disabled_at`), the dispatcher lets a single delivery through as a half-open trial: success re-activates the
  endpoint and resets its failure counter; failure re-arms the cooldown so the next trial waits another
  `cooldownMs`. Applies to any disabled registered endpoint (breaker- or `410`-disabled); within the cooldown no
  HTTP attempt is made. Wired across all four adapters as `Store.reactivateEndpoint`.
- **Cancel API:** `relay.cancel(outboxId)` stops a not-yet-sent row, moving it `pending → cancelled`
  only while it is still pending (an already-claimed `in_flight` or terminal row is left untouched). Returns
  `{ cancelled }` so a caller can tell "stopped in time" from "already sent / unknown id". Implemented across
  all four adapters and validated up front (a malformed id fails as `INVALID_ARGUMENT`).
- **Auto-disable circuit breaker:** `createRelay({ circuitBreaker: { failureThreshold: N } })` (default
  `0` = off) auto-disables a registered endpoint after `N` consecutive failed deliveries; a success resets the
  counter. The increment-and-disable is a single atomic UPDATE on the previously inert `consecutive_failures`
  column. Fail-open (a counter-update error never stalls a delivery) and only affects the registered-endpoint
  workflow; the `410 Gone` path still disables directly.
- **One-shot dispatch for serverless/cron:** `dispatcher.runOnce({ reclaim, maxRows })` and the
  convenience `relay.dispatchOnce(options, runOptions)` drain the queue once and return (no long-lived loop),
  honouring `concurrency`/`batchSize`/`ordering`. Returns `{ processed }`; refuses to run while the continuous
  loop is active. Suitable for Lambda/cron where a persistent dispatcher cannot run.
- **Operability guards:** `relay.get(outboxId)` fetches a single outbox row (read-only, secret-free), and
  `relay.replay(...)` now clamps its selection to a safe ceiling and returns `{ ids, capped }` so a broad
  `{ status: "dead" }` replay can never fan out into an unbounded mass re-send — page on while `capped` is true.
- **Built-in retention / pruning:** `relay.prune({ olderThan, statuses?, limit? })` deletes terminal rows
  older than a cutoff in bounded, oldest-first batches (ledger attempts cascade), returning `{ deleted }`. Only
  non-active statuses are eligible (default `delivered`/`dead`/`cancelled`); passing `pending`/`in_flight` fails as
  `INVALID_ARGUMENT`, so a live row is never deleted. Implemented across all four adapters; each call is capped
  (default 10 000, max 100 000) so it never deletes — or locks — an unbounded set.
- **`commitcourier doctor` CLI:** a `bin` for local dev and CI that checks readiness — database schema,
  applied vs pending migrations, dispatch indexes, queue health, and configuration (defaults vs overrides, the
  recommended-but-unset checklist with rationale, and risk warnings). Supports `--config <file>`, `--skip-db`,
  `--database-url`, and `--json`, and exits non-zero when the core tables are missing or the config is invalid
  (so a deploy can gate on it). `pg` is needed only for the database checks.
- **Low-latency delivery accelerator:** an optional, fail-open wake seam. `createRelay({ accelerator })`
  signals the accelerator after each enqueue and subscribes every dispatcher it creates, so a freshly
  enqueued row is delivered near-immediately instead of after the poll interval. The first
  implementation, `createPgAccelerator` from `commitcourier/accelerator/pg`, uses Postgres
  LISTEN/NOTIFY: the `NOTIFY` rides the enqueue transaction (delivered on COMMIT, never before the row
  is visible) and a dedicated, self-healing LISTEN connection cuts the dispatcher's idle backoff short.
  The outbox row stays the single source of truth — a missed wake only delays delivery, never loses it
  (the poller reclaims it). The generic `Accelerator` seam is dependency-free; a BullMQ accelerator is a
  planned future adapter on the same seam.
- **Schema migration version table:** `migrate()` now records applied migrations in a
  `commitcourier_migrations` table and applies only the not-yet-applied ones in order (still idempotent,
  and safe on deployments that pre-date the table). This replaces the single-file apply across all four
  adapters and prepares the ground for incremental `00N_*` schema changes.
- **Read-only DLQ / outbox list API:** `relay.list({ status, since, endpointId, limit, cursor })`
  pages outbox rows newest-first by a monotonic `seq`, for DLQ inspection and monitoring. Rows are
  secret-free (the signing-key snapshot is never selected) and paging is seq-keyset (`nextCursor`).
- **Endpoint listing:** `endpoints.list({ status, limit, cursor })` returns secret-free endpoint
  summaries (no `secret`/`secret_secondary`), id-keyset paged. Both list methods are implemented across
  all four adapters (`pg`/`knex`/`drizzle`/`prisma`). List filters are validated up front, so a malformed
  `cursor`/`status` fails as a new `INVALID_ARGUMENT` `RelayError` instead of a raw Postgres cast error.
- **OpenTelemetry adapter:** `commitcourier/otel` exports `createOtelInstrumentation({ tracer, meter })`,
  returning `{ instrument, hooks }` to pass to `createRelay`. Each delivery attempt emits one CLIENT span
  with secret-free attributes; the outcome updates a `commitcourier.deliveries` counter
  (`outcome = delivered | retry | dead`) and a `commitcourier.delivery.duration` histogram.
  `@opentelemetry/api` is an optional peer; the seam itself (`RelayInit.instrument` + secret-free
  `DeliveryStart`/`DeliveryEvent` carrying `endpointId`/`host`) is dependency-free and fail-open.
- **Key rotation / dual signing:** during a rotation, deliveries to a registered endpoint are
  signed with both the current and previous keys (Standard Webhooks space-separated `v1,…` signatures),
  so a receiver on either key verifies. New admin ops `endpoints.rotateSecret(id, newSecret)` and
  `endpoints.finalizeRotation(id)`, backed by a new `secret_secondary` column (added via idempotent
  migration; encrypted at rest when a `cipher` is configured).
- **`Retry-After` support:** a retryable response carrying `Retry-After` (delta-seconds or
  HTTP-date) schedules the next attempt at `max(backoff, Retry-After)`, clamped to `retry.capMs`.
- **Immediate `410 Gone` invalidation:** a `410` response moves the row straight to `dead`
  without consuming the retry budget and disables the registered endpoint.
- **Opt-in per-endpoint FIFO:** `createDispatcher({ ordering: "per-endpoint" })` delivers each
  registered endpoint's rows strictly in arrival order (one in-flight per endpoint); the default
  (`"none"`) stays unordered and fully concurrent. Inline destinations are unaffected. Ordering uses a
  monotonic insertion sequence (`webhook_outbox.seq`), so events enqueued together in one transaction
  (a bulk/same-TX enqueue) are still delivered in insertion order.
- **Drizzle adapter:** `drizzleStore` exported from `commitcourier/store/drizzle`, reusing the
  same Postgres dialect and contract as the `pg`/`knex` adapters. `drizzle-orm` is an optional peer.
- **Prisma adapter:** `prismaStore` exported from `commitcourier/store/prisma`, raw-SQL based
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

- Signing now memoises the imported HMAC `CryptoKey` per secret (bounded, process-wide LRU), removing a
  `crypto.subtle.importKey` from every delivery (and from each key during a dual-signing rotation) — a CPU
  win at high throughput. The signature output is unchanged; keys stay non-extractable.
- The dispatch claim and reclaim queries now use partial indexes over only the `pending` /
  `in_flight` rows, so they stay fast as delivered/dead rows accumulate.
- The dispatcher's idle wait now backs off adaptively from ~50ms up to `pollIntervalMs`, lowering the
  latency of the first delivery after an idle period.

### Fixed

- Integration tests no longer skip on Windows Docker Desktop: the Docker probe falls back to the
  Docker CLI instead of relying on a named pipe that `existsSync` cannot detect.

## [0.1.0] - 2026-06-25

Initial development baseline (never published to npm).

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

[Unreleased]: https://github.com/Y1-Effy/CommitCourier/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/Y1-Effy/CommitCourier/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Y1-Effy/CommitCourier/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Y1-Effy/CommitCourier/releases/tag/v0.2.0
