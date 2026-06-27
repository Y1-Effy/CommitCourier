# CommitCourier

> Transactional Outbound Webhook delivery for Node.js / TypeScript, backed by your **existing PostgreSQL**.

[![npm version](https://img.shields.io/npm/v/commitcourier.svg)](https://www.npmjs.com/package/commitcourier)
[![license](https://img.shields.io/github/license/Y1-Effy/CommitCourier)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.19-brightgreen)](https://nodejs.org)

🇯🇵 日本語版: **[README.ja.md](./README.ja.md)** · 🔒 [Security policy](./SECURITY.md)

CommitCourier bolts reliable outbound webhooks onto an existing Node.js / TypeScript app — framework-agnostic, with **no extra infrastructure** (just the Postgres you already run). You `enqueue` a webhook **inside your own business transaction**, so it commits or rolls back atomically with your business write. The background dispatcher then delivers it with Standard Webhooks signing, retries, a DLQ, a full delivery ledger, SSRF protection, and single-delivery across instances.

> ⚠️ **Pre-release** (`v0.1.0`). The API and the package name may still change before `1.0.0`.

---

## Why

Updating business state and sending a webhook are two separate actions. If a crash or rollback lands between them, you get a **dual-write** bug:

- **Phantom webhook** — you enqueue the webhook first, then the business transaction rolls back. A customer receives `order.created` for an order that never existed.
- **Lost webhook** — you commit the business transaction first, then the process dies before enqueuing. The order is final, but the notification never fires.

Existing tools can't fix this structurally: SaaS senders (Svix, Outpost) and Redis-backed queues (BullMQ) enqueue to a remote system that **can't join your local DB transaction**, and broker-outbox libraries ride your transaction but only deliver to a **message broker** — no HTTP webhook delivery, no signing, no SSRF guard, no delivery ledger.

CommitCourier is the one embedded library that rides **your own DB transaction** and carries it all the way to **webhook-grade HTTP delivery**. Because the outbox row is written in the same transaction as your business change, dual-write inconsistency is impossible _by construction_.

## Features

- **Transactional `enqueue`** — rides your DB transaction; the webhook is atomic with your business write (fail-closed).
- **Postgres-only** — no Redis, no separate broker, no extra server.
- **Standard Webhooks signing** — receivers verify with any off-the-shelf Standard Webhooks library.
- **Retries with exponential backoff + jitter, and a DLQ** for exhausted rows.
- **Delivery ledger** — every attempt's request headers, response status, body snippet, and duration are recorded for support and audit.
- **Replay** — re-enqueue by id or by filter (e.g. all `dead` rows since a time).
- **SSRF protection on by default** — private / loopback / link-local / cloud-metadata destinations are blocked.
- **Single delivery across instances** via `FOR UPDATE SKIP LOCKED`; at-least-once via visibility-timeout reclaim.
- **Observe mode** — record what _would_ be sent without sending, for safe phased rollout.
- **Optional at-rest encryption** for signing secrets — plug in `cipher` (a built-in WebCrypto AES-256-GCM helper, or your own KMS/Vault adapter) to keep `secret_snapshot` / endpoint secrets as ciphertext in the DB.

## Install

```bash
npm install commitcourier
# plus the driver you use (optional peer dependency):
npm install pg      # or: npm install knex
```

**Requirements:** Node.js **22.19.0+**, **PostgreSQL 12+** (anything with `FOR UPDATE SKIP LOCKED`, i.e. ≥ 9.5, works). Ships dual **ESM/CJS** builds with bundled TypeScript types. `pg` and `knex` are **optional peer dependencies** — install whichever one you use.

## Quick start

### 1. Create the tables

`migrate()` applies idempotent DDL (`webhook_outbox`, `webhook_delivery_attempts`, `webhook_endpoints`). Run it once at deploy time.

```ts
import { Pool } from "pg";
import { postgresStore } from "commitcourier/store/pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const store = postgresStore({ pool });

await store.migrate();
```

### 2. Create the relay

`createRelay` is async: it validates config and fails fast if the tables are missing.

```ts
import { createRelay } from "commitcourier";

const relay = await createRelay({
  store,
  // all of the following are optional and shown with their defaults:
  mode: "active",
  signing: { scheme: "standard-webhooks" },
  retry: { maxAttempts: 12, backoff: "exponential", baseMs: 1_000, capMs: 3_600_000, jitter: 0.2 },
  delivery: { timeoutMs: 15_000, bodySnippetBytes: 4_096 },
  ssrf: { blockPrivateRanges: true, allowlist: [], blocklist: [] },
});
```

### 3. Enqueue inside your business transaction

`enqueue` takes the transaction handle as its **required first argument**. With `pg` that handle is the `PoolClient` running your `BEGIN`/`COMMIT`. If the transaction rolls back, the outbox row disappears with it.

```ts
const client = await pool.connect();
try {
  await client.query("BEGIN");

  // ... your business writes on `client` ...
  await client.query("INSERT INTO orders (id, amount) VALUES ($1, $2)", [orderId, amount]);

  // Rides the same transaction (fail-closed):
  await relay.enqueue(client, {
    eventType: "order.created",
    payload: { orderId, amount },
    endpoint: { url: "https://customer.example.com/webhooks", secret: "whsec_..." },
    idempotencyKey: orderId, // optional
  });

  await client.query("COMMIT");
} catch (err) {
  await client.query("ROLLBACK"); // the outbox row rolls back too
  throw err;
} finally {
  client.release();
}
```

> No business transaction? `relay.enqueueUnsafe(input)` enqueues on its own connection — but you **lose the atomicity guarantee**, which is the whole point. Use it only where there is genuinely no surrounding transaction.

> **Inline vs registered endpoints.** The examples pass the destination inline as `endpoint: { url, secret }`, which is the primary path: the secret is snapshotted onto the outbox row at enqueue time. You can instead reference a row in `webhook_endpoints` with `endpoint: { endpointId }`, and manage those rows through the `relay.endpoints` admin API — `register({ url, secret, … })`, `update`, `enable`, `disable`, and `get`.

### 4. Run the dispatcher

The dispatcher polls for due rows and delivers them in the background. Run it in your app process or a dedicated worker — running several copies is safe.

```ts
const dispatcher = relay.createDispatcher({
  concurrency: 8,
  pollIntervalMs: 1_000,
  reclaimAfterMs: 300_000,
});

await dispatcher.start();

// On shutdown — graceful: stops new ticks and drains in-flight deliveries.
process.on("SIGTERM", () => void dispatcher.stop());
```

### Using Knex instead of pg

```ts
import { knexStore } from "commitcourier/store/knex";

const store = knexStore({ knex });
await store.migrate();

const relay = await createRelay({ store });

await knex.transaction(async (trx) => {
  // ... your business writes on `trx` ...
  await relay.enqueue(trx, {
    eventType: "order.created",
    payload: { orderId, amount },
    endpoint: { url: "https://customer.example.com/webhooks", secret: "whsec_..." },
  });
});
```

## How it works

```
┌──────────────────────────────────────────────────────────┐
│                  Your application                        │
│                                                          │
│   business logic ── db.tx ──┐                            │
│                             ▼                            │
│              relay.enqueue(trx, …)                       │  ← INSERT outbox row in the same tx
└─────────────────────────┬────────────────────────────────┘
                          │ commit / rollback (atomic)
                          ▼
          ┌─────────────────────────────────┐
          │  PostgreSQL (your existing DB)  │  ← source of truth
          │  webhook_outbox                 │
          │  webhook_delivery_attempts      │
          │  webhook_endpoints (optional)   │
          └───────────────┬─────────────────┘
                          │ poll (claim rows with SKIP LOCKED)
                          ▼
     ┌──────────────────────────────────────────────┐
     │  Dispatcher (background loop)                │  ← fail-open
     │   ├ Claim:      lock due rows exclusively    │
     │   ├ SSRF Guard: validate destination URL     │
     │   ├ Signer:     Standard Webhooks signature  │
     │   ├ HTTP:       POST with timeout            │
     │   └ Ledger:     record attempt → transition  │
     │                 (delivered / retry / dead)   │
     └──────────────────────────────────────────────┘
                          │
                          ▼
                   external endpoint
```

The two paths are deliberately separate:

- **`enqueue` is fail-closed** — it rides your transaction. If the outbox row can't be written, your business transaction doesn't commit either. (In practice this is just a cheap local `INSERT`, far more reliable than a remote call.)
- **`dispatch` is fail-open** — a delivery or DB error during dispatch never propagates to your business path. It's logged, recorded in the ledger, and left to retry / DLQ.

A row's lifecycle:

```
pending ──claim──▶ in_flight ──2xx──▶ delivered
   ▲                   │
   │ fail & attempts<max (available_at = now + backoff)
   └───────────────────┤
                       │ fail & attempts>=max
                       ▼
                     dead (DLQ)

enqueue in observe mode ─▶ observed   (recorded, never sent)
manual cancel           ─▶ cancelled
```

If a worker dies mid-delivery, its row stays `in_flight` until `locked_at` exceeds the visibility timeout (`reclaimAfterMs`, default 5 min); the next tick reclaims it back to `pending`. That's how CommitCourier guarantees **at-least-once**.

## Configuration

All config is optional and merged over safe defaults. Invalid values are rejected at startup with `RelayError("CONFIG_INVALID")`; dangerous-but-valid ones (e.g. disabling the SSRF guard) are allowed but warned via the logger.

| Group      | Option               | Default               | Notes                                                                                |
| ---------- | -------------------- | --------------------- | ------------------------------------------------------------------------------------ |
|            | `mode`               | `"active"`            | `"observe"` records rows as `observed` and never sends.                              |
| `signing`  | `scheme`             | `"standard-webhooks"` | Only Standard Webhooks is supported.                                                 |
| `retry`    | `maxAttempts`        | `12`                  | Integer ≥ 1.                                                                         |
| `retry`    | `backoff`            | `"exponential"`       | `baseMs * 2^(attempts-1)`, capped.                                                   |
| `retry`    | `baseMs`             | `1000`                |                                                                                      |
| `retry`    | `capMs`              | `3600000`             | Must be ≥ `baseMs`.                                                                  |
| `retry`    | `jitter`             | `0.2`                 | Fraction in `0..1`, on by default to avoid thundering herds.                         |
| `delivery` | `timeoutMs`          | `15000`               | Per-request HTTP timeout.                                                            |
| `delivery` | `bodySnippetBytes`   | `4096`                | How much of the response body is stored in the ledger.                               |
| `delivery` | `keepAliveTimeoutMs` | `10000`               | undici keep-alive window; longer reuses TCP/TLS across bursts to the same host.      |
| `delivery` | `connections`        | _(undici default)_    | Optional cap on simultaneous connections per origin.                                 |
| `ssrf`     | `blockPrivateRanges` | `true`                | Blocks private / loopback / link-local / metadata IPs.                               |
| `ssrf`     | `allowlist`          | `[]`                  | Host patterns to permit.                                                             |
| `ssrf`     | `blocklist`          | `[]`                  | Host patterns to deny.                                                               |
|            | `endpointCacheTtlMs` | `0` (off)             | TTL (ms) for an in-process registered-endpoint lookup cache; see Performance tuning. |

Dispatcher options (`relay.createDispatcher({ … })`):

| Option           | Default           | Notes                                                                                                                      |
| ---------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `concurrency`    | `8`               | Max concurrent deliveries.                                                                                                 |
| `pollIntervalMs` | `1000`            | Upper bound of the idle poll wait; an idle loop backs off from ~50ms up to this, and a full batch ticks again immediately. |
| `reclaimAfterMs` | `300000`          | Visibility timeout: reclaim `in_flight` rows older than this.                                                              |
| `batchSize`      | `concurrency * 2` | Rows claimed per tick.                                                                                                     |

### Performance tuning

Throughput is mostly about giving the dispatcher room to work:

- **Concurrency vs. pool size.** Raising `concurrency` only helps if the `pg.Pool` has connections to spare: the dispatch path uses one connection per in-flight `claimDue` / `completeAttempt`. Size `Pool({ max })` to at least `concurrency` plus headroom, or deliveries stall waiting on the pool.
- **Batch and connections.** `batchSize` (default `concurrency * 2`) caps the in-flight buffer; `delivery.connections` caps sockets per destination. Tune both to the workload, and lengthen `delivery.keepAliveTimeoutMs` when you deliver many events to the same hosts.
- **Registered-endpoint cache.** With the registered-endpoint workflow every delivery looks the endpoint up in the DB. Set `endpointCacheTtlMs` (e.g. `1000`–`5000`) to cache lookups in-process; `update`/`disable` evict immediately within the process, and the TTL bounds how long another process's change can be stale. It has no effect on the inline `{ url, secret }` workflow. **With multiple dispatcher processes**, `endpointCacheTtlMs` is also the upper bound on how long another process keeps delivering with a stale endpoint after a `disable` or a key rotation — so keep it short, and when rotating a secret, leave `finalizeRotation` until at least `ttlMs` after the last delivery (until then a peer may still sign with only the previous key).
- **Indexes are built in.** The claim and reclaim queries use partial indexes over only the `pending` / `in_flight` rows, so they stay fast as delivered/dead rows accumulate — no tuning needed.

**Phased rollout:** start in `mode: "observe"` to record the volume and destinations of what _would_ be sent, diff it against expectations, then switch to `"active"`.

**Signing secret format:** a `whsec_`-prefixed secret is treated as Base64 per the Standard Webhooks convention and decoded to raw key bytes; any other string is used as raw UTF-8 bytes.

**Encrypting secrets at rest:** pass `cipher` to `createRelay({ store, cipher })` to keep signing secrets as ciphertext in the DB. Use the built-in `createAesGcmCipher(key)` (WebCrypto AES-256-GCM; `generateSecretKey()` mints a key) or your own `SecretCipher` over a KMS/Vault. Managing the key is your responsibility; omitting `cipher` stores secrets as-is (plaintext).

## Operations

```ts
// Delivery ledger for one outbox row (every attempt, response, duration).
const attempts = await relay.attempts({ outboxId });

// Replay: re-enqueue as fresh pending copies. By id…
const { ids } = await relay.replay({ outboxId });
// …or by filter (e.g. everything dead since a timestamp):
await relay.replay({ filter: { status: "dead", since: new Date(Date.now() - 86_400_000) } });

// Disable a registered endpoint.
await relay.endpoints.disable(endpointId);

// Graceful shutdown.
await dispatcher.stop();
```

### Logging & observability

The dispatch path is **fail-open**: delivery, claim, and reclaim failures are never thrown — they are sent to the **logger**, which **defaults to a no-op**. If you don't inject a logger, delivery problems are silent. In production, always pass one:

```ts
const relay = await createRelay({
  store,
  logger: {
    debug: (msg, meta) => console.debug(msg, meta),
    info: (msg, meta) => console.info(msg, meta),
    warn: (msg, meta) => console.warn(msg, meta),
    error: (msg, meta) => console.error(msg, meta),
  },
});
```

The logger also surfaces startup warnings for dangerous-but-valid config (e.g. a disabled SSRF guard). You can inject `clock?: () => Date` too — useful for deterministic tests.

### OpenTelemetry (tracing & metrics)

The optional `commitcourier/otel` adapter (v1.2) maps deliveries onto OpenTelemetry spans and metrics. It depends on `@opentelemetry/api` as an optional peer dependency, so the main entry never pulls OTel into scope. Wire the result into `createRelay`:

```ts
import { trace, metrics } from "@opentelemetry/api";
import { createRelay } from "commitcourier";
import { createOtelInstrumentation } from "commitcourier/otel";

const { instrument, hooks } = createOtelInstrumentation({
  tracer: trace.getTracer("commitcourier"),
  meter: metrics.getMeter("commitcourier"),
});
const relay = await createRelay({ store, instrument, hooks });
```

Each delivery attempt emits one CLIENT span with secret-free attributes (`webhook.id`, `webhook.event_type`, `webhook.attempt`, `http.response.status_code`, `server.address` / `server.port`, `endpoint.id`); the same outcome increments a `commitcourier.deliveries` counter (`outcome = delivered | retry | dead`) and records a `commitcourier.delivery.duration` histogram. The seam is fail-open: an instrumentation error is logged and swallowed, never stalling the dispatcher. For low-level use you can pass your own `instrument` / `hooks` without OTel.

The counter and histogram are recorded **per delivery attempt** (each retry counts again, plus the rare re-delivery after a worker crash) — they are attempt counts, not unique-row counts.

### Low-latency delivery (accelerator)

By default the dispatcher polls, so a row enqueued onto a quiet queue waits up to `pollIntervalMs` before delivery starts. The optional **accelerator (v2)** cuts that wait: each enqueue wakes a listening dispatcher so delivery begins near-immediately. The outbox row stays the single source of truth — a missed wake only delays delivery (the poller still reclaims the row), so the accelerator never affects correctness or availability.

The first implementation, `commitcourier/accelerator/pg`, uses Postgres LISTEN/NOTIFY (no extra infrastructure). The `NOTIFY` rides the enqueue transaction, so a listener never wakes before the row is visible; the LISTEN runs on its own self-healing connection.

```ts
import { Pool, Client } from "pg";
import { createRelay } from "commitcourier";
import { postgresStore } from "commitcourier/store/pg";
import { createPgAccelerator } from "commitcourier/accelerator/pg";

const pool = new Pool(/* … */);
const accelerator = createPgAccelerator({
  pool,
  // A dedicated connection for LISTEN (must NOT come from the delivery pool):
  listen: async () => {
    const c = new Client(/* … */);
    await c.connect();
    return c;
  },
});

const relay = await createRelay({ store: postgresStore({ pool }), accelerator });
// Every dispatcher this relay creates now wakes on enqueue:
relay.createDispatcher({ pollIntervalMs: 10_000 }).start();
```

`pg` is the only peer needed (already required by the `pg` store). A BullMQ accelerator is a planned future adapter on the same `Accelerator` seam.

Two operational notes: (1) the transactional wake rides your enqueue transaction, so in the rare case the `NOTIFY` itself fails, `enqueue` / `enqueueMany` roll back with your business write (fail-closed) — `enqueueUnsafe` swallows it. (2) If the LISTEN connection degrades without surfacing an error, wakes are simply missed and delivery falls back to polling (bounded by `pollIntervalMs`); correctness is unaffected because the poller remains the source of truth.

### Data retention

CommitCourier never deletes rows on its own. `webhook_outbox` (including `delivered`/`dead` rows) and `webhook_delivery_attempts` grow over time, so schedule your own pruning — for example, delete `delivered` outbox rows older than your retention window. Deleting an outbox row cascades to its ledger attempts (`ON DELETE CASCADE`).

### Inspecting the DLQ (`dead` rows)

Use the read-only `relay.list({ filter })` API (v1.2) to inspect dead rows before replaying. It returns secret-free rows newest-first (by a monotonic `seq`) with keyset pagination — `replay({ filter })` then **re-enqueues** the ones you choose (a write):

```ts
// First page of the DLQ, newest first.
const { items, nextCursor } = await relay.list({ status: "dead", limit: 100 });
for (const r of items) {
  console.log(r.id, r.eventType, r.attempts, r.lastError);
}
// Next page (when nextCursor is non-null).
if (nextCursor) await relay.list({ status: "dead", limit: 100, cursor: nextCursor });
```

`list` accepts `{ status, since, endpointId, limit, cursor }` and never returns the signing-key snapshot. (You can still query `webhook_outbox` directly if you prefer raw SQL.)

> **Scope your replays.** `replay({ filter })` selects every matching row and inserts the copies in a single transaction. On a very large DLQ that means a big in-memory result and one long-running transaction, so narrow the filter (e.g. by `since` or `endpointId`) and replay in chunks rather than re-enqueuing hundreds of thousands of rows at once.

## Error handling

Every error the library throws is a `RelayError` with a stable, machine-readable `code`:

| Code                 | Thrown by                       | Meaning                                                                      |
| -------------------- | ------------------------------- | ---------------------------------------------------------------------------- |
| `CONFIG_INVALID`     | `createRelay` (startup)         | Invalid configuration (fail-fast).                                           |
| `MISSING_TABLES`     | `createRelay` (startup)         | Core tables are absent — run `store.migrate()`.                              |
| `ENQUEUE_NO_TARGET`  | `enqueue` / `enqueueUnsafe`     | Neither `{ url, secret }` nor `{ endpointId }` was provided.                 |
| `INVALID_ARGUMENT`   | `list` / `endpoints.list`       | A list filter was malformed (e.g. a non-numeric `cursor`, unknown `status`). |
| `SSRF_BLOCKED`       | dispatch (recorded, not thrown) | Destination resolved to a blocked range.                                     |
| `ENDPOINT_NOT_FOUND` | dispatch (recorded, not thrown) | `endpointId` is not registered.                                              |
| `ENDPOINT_DISABLED`  | dispatch (recorded, not thrown) | The registered endpoint is disabled.                                         |
| `MISSING_SECRET`     | dispatch (recorded, not thrown) | An inline destination has no stored secret to sign with.                     |

The split mirrors the architecture: **enqueue-path** errors are _thrown_ so they roll back your transaction (fail-closed), while **dispatch-path** failures are _recorded in the ledger_ and retried, never thrown into your app (fail-open). Inspect the latter with `relay.attempts({ outboxId })`.

## Verifying signatures (receiver side)

Each delivery POSTs JSON with these headers:

| Header              | Value                                                     |
| ------------------- | --------------------------------------------------------- |
| `webhook-id`        | The outbox row id (the signature's message id).           |
| `webhook-timestamp` | Unix seconds.                                             |
| `webhook-signature` | `v1,<base64 HMAC-SHA256>` over `{id}.{timestamp}.{body}`. |
| `content-type`      | `application/json`.                                       |
| `idempotency-key`   | Present only if you supplied one at enqueue time.         |

Because this is the [Standard Webhooks](https://www.standardwebhooks.com/) convention, your receiver can verify it with any compatible verification library — CommitCourier does not invent its own scheme.

> **Body normalization.** The `payload` is stored as Postgres `jsonb`, so the delivered body is the JSON round-trip of what you enqueued (object key order is not preserved, duplicate keys collapse, insignificant whitespace is dropped). The signature is always computed over the exact bytes sent, so verification never fails because of this — but the delivered bytes are not guaranteed identical to your input. If you need byte-exact delivery, enqueue the payload as a pre-serialized string.

## Guarantees & non-goals

**Guarantees**

- No phantom / lost webhooks from dual-write — the outbox row is atomic with your business transaction.
- No event loss on process crash — at-least-once via visibility-timeout reclaim.
- No double delivery across instances — `FOR UPDATE SKIP LOCKED`.
- Tamper / spoof detection — Standard Webhooks signatures.
- Outbound SSRF blocked by default.

**Non-goals** (called out honestly)

- **Exactly-once _effects_** at the receiver. CommitCourier provides at-least-once + an idempotency key; final dedup is the receiver's responsibility.
- **Total ordering** across an endpoint. Default delivery is unordered (per-endpoint FIFO is available as an opt-in feature: `createDispatcher({ ordering: "per-endpoint" })`).
- **Unbounded scale.** This targets small-to-medium volume on your existing Postgres, not billions/sec.
- **Encryption-key management.** Signing secrets can be encrypted at rest by configuring a `cipher` (see Configuration); managing the key itself — storage, distribution, rotation — is yours. Without a `cipher`, at-rest encryption is your database's responsibility.
- Inbound webhook receiving / verification, and a customer-facing management portal UI.

## Removing CommitCourier

CommitCourier is non-invasive and reversible. Everything lives in three dedicated tables (`webhook_outbox`, `webhook_delivery_attempts`, `webhook_endpoints`). Stop the dispatcher, remove the `enqueue` calls, and drop those tables — your business schema is untouched.

## API surface

| Import                         | Exports                                                                                                                                                                                       |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commitcourier`                | `createRelay`, the `Relay`/`RelayInit` types, the `Store` port, and all domain types.                                                                                                         |
| `commitcourier/core`           | The pure, dependency-free domain layer (`sign`, `backoffMs`, state transitions, SSRF helpers, `resolveConfig`, `RelayError`, types). Importing it pulls in no driver and no `node:*` builtin. |
| `commitcourier/store/pg`       | `postgresStore({ pool })` — `Store<PoolClient>`.                                                                                                                                              |
| `commitcourier/store/knex`     | `knexStore({ knex })` — `Store<Knex.Transaction>`.                                                                                                                                            |
| `commitcourier/accelerator/pg` | `createPgAccelerator({ pool, listen })` — optional low-latency wake via Postgres LISTEN/NOTIFY, passed as `createRelay({ accelerator })`.                                                     |

Key signatures:

```ts
function createRelay<TTx>(init: RelayInit<TTx>): Promise<Relay<TTx>>;

interface Relay<TTx> {
  enqueue(trx: TTx, input: EnqueueInput): Promise<{ id: string }>;
  enqueueMany(trx: TTx, inputs: EnqueueInput[]): Promise<{ ids: string[] }>;
  enqueueUnsafe(input: EnqueueInput): Promise<{ id: string }>;
  createDispatcher(options?: DispatcherOptions): Dispatcher;
  attempts(opts: { outboxId: string }): Promise<DeliveryAttempt[]>;
  replay(opts: { outboxId: string } | { filter: ReplayFilter }): Promise<{ ids: string[] }>;
  stats(): Promise<OutboxStats>;
  endpoints: EndpointAdmin; // register / update / enable / disable / get
}
```

## Status & roadmap

- **v1 (current):** Postgres store, `pg` + Knex adapters, transactional enqueue, poller-based dispatcher (no external queue), Standard Webhooks signing (single key), retry / backoff / jitter / DLQ, delivery ledger, replay by id, SSRF protection, observe mode, a registered-endpoint admin API (`register` / `update` / `enable` / `disable` / `get`), optional at-rest secret encryption (`cipher`), and throughput tuning (partial claim/reclaim indexes, undici keep-alive, an optional registered-endpoint cache, adaptive idle polling).
- **v1.1:** key rotation / dual signing (`endpoints.rotateSecret` / `finalizeRotation`), `Retry-After` support, immediate `410 Gone` endpoint invalidation, opt-in per-endpoint FIFO (`createDispatcher({ ordering: "per-endpoint" })`), and Drizzle (`commitcourier/store/drizzle`) + Prisma (`commitcourier/store/prisma`) adapters.
- **v1.2:** read-only DLQ/outbox list API (`relay.list({ status: "dead", … })`, secret-free, seq-keyset paging), endpoint listing (`endpoints.list({ status, … })`), and the OpenTelemetry adapter (`commitcourier/otel` — span per delivery + outcome counter/duration histogram, via the fail-open `instrument` / `hooks` seam).
- **v2:** Low-latency delivery accelerator (generic `Accelerator` seam + Postgres LISTEN/NOTIFY adapter `commitcourier/accelerator/pg`; the outbox row stays the source of truth), schema migration version table (`commitcourier_migrations` + incremental `migrate()`). A BullMQ accelerator and further endpoint-management API remain planned on the same seams.

## Security

Found a vulnerability? **Please don't open a public issue** — report it privately as described in the **[security policy](./SECURITY.md)**. That document also covers the security model (SSRF defaults, signing, secret handling) and what is in vs out of scope.

## License

[MIT](./LICENSE)
