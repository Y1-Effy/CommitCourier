# CommitCourier

> 既存の PostgreSQL だけで動く、Node.js / TypeScript 向けのトランザクショナル Outbound Webhook 配信ライブラリ。

[![npm version](https://img.shields.io/npm/v/commitcourier.svg)](https://www.npmjs.com/package/commitcourier)
[![license](https://img.shields.io/npm/l/commitcourier.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/commitcourier.svg)](https://nodejs.org)

🇬🇧 English: **[README.md](./README.md)**（こちらがメインです） · 🔒 [セキュリティポリシー](./SECURITY.ja.md)

CommitCourier は、既存の Node.js / TypeScript アプリに信頼性のある Outbound Webhook を**後付け**するライブラリです。フレームワーク非依存で、**追加インフラは不要**（すでに動かしている Postgres だけ）。webhook の `enqueue` を**あなた自身の業務トランザクションの中**で行うため、業務の書き込みと原子的に commit / rollback されます。バックグラウンドの dispatcher が、その後を Standard Webhooks 署名・リトライ・DLQ・配信台帳・SSRF 防御・複数インスタンスでの単一配信まで一貫して担います。

> ⚠️ **プレリリース**（`v0.1.0`）です。API およびパッケージ名は `1.0.0` までに変更される可能性があります。

---

## なぜ必要か

業務状態の更新と webhook 送信は別のアクションです。その間でクラッシュや rollback が起きると、**dual-write（二重書き込み）不整合**が発生します。

- **幻の Webhook** — 先に webhook を enqueue → 業務トランザクションが rollback。存在しない注文の `order.created` が顧客に届く。
- **消えた Webhook** — 先に業務トランザクションを commit → enqueue 直前にプロセスが停止。注文は確定したのに通知が永久に飛ばない。

既存手段はこれを構造的に解けません。SaaS 型（Svix / Outpost）や Redis 型キュー（BullMQ）は、**ローカル DB トランザクションに入れられないリモート系**へ enqueue します。ブローカー Outbox 系ライブラリは業務トランザクションに相乗りできますが、配信先は**メッセージブローカー**であり、HTTP webhook 配信・署名・SSRF 防御・配信台帳を持ちません。

CommitCourier は、**あなた自身の DB トランザクションに相乗りし**、その先を **webhook-grade の HTTP 配信**まで運ぶ唯一の埋め込み型ライブラリです。Outbox 行が業務変更と同一トランザクションで書かれるため、dual-write 不整合は**定義上起きません**。

## 特長

- **トランザクショナル `enqueue`** — 業務トランザクションに相乗りし、webhook が業務の書き込みと原子的に整合（fail-closed）。
- **Postgres だけ** — Redis も別ブローカーも別サーバーも不要。
- **Standard Webhooks 署名** — 受信側は既存の Standard Webhooks 検証ライブラリでそのまま検証可能。
- **指数バックオフ＋ジッターのリトライと DLQ**（試行上限超過分の退避）。
- **配信台帳** — 試行ごとのリクエストヘッダ・応答ステータス・本文スニペット・所要時間を記録（サポート・監査用）。
- **リプレイ** — ID 指定、またはフィルタ指定（例：特定時刻以降の `dead` 全件）で再 enqueue。
- **SSRF 防御は既定 ON** — プライベート／ループバック／リンクローカル／クラウドメタデータ宛先を遮断。
- **複数インスタンスでの単一配信**を `FOR UPDATE SKIP LOCKED` で担保。可視性タイムアウト回収で at-least-once。
- **観測（observe）モード** — 実送信せずに「送るはずの内容」を記録し、安全に段階導入。

## インストール

```bash
npm install commitcourier
# 使うドライバを追加（optional peer dependency）：
npm install pg      # または: npm install knex
```

**動作要件**：Node.js **20.18.1 以上**、**PostgreSQL 12 以上**（`FOR UPDATE SKIP LOCKED` が使えれば 9.5 以上で動作）。**ESM/CJS** デュアルビルドと TypeScript 型定義を同梱します。`pg` と `knex` は **optional peer dependency** です。使う方だけをインストールしてください。

## クイックスタート

### 1. テーブルを作成する

`migrate()` は冪等な DDL（`webhook_outbox` / `webhook_delivery_attempts` / `webhook_endpoints`）を適用します。デプロイ時に一度実行してください。

```ts
import { Pool } from "pg";
import { postgresStore } from "commitcourier/store/pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const store = postgresStore({ pool });

await store.migrate();
```

### 2. relay を作成する

`createRelay` は async です。設定を検証し、テーブルが無ければ即座に失敗します。

```ts
import { createRelay } from "commitcourier";

const relay = await createRelay({
  store,
  // 以下はすべて任意。既定値を併記：
  mode: "active",
  signing: { scheme: "standard-webhooks" },
  retry: { maxAttempts: 12, backoff: "exponential", baseMs: 1_000, capMs: 3_600_000, jitter: 0.2 },
  delivery: { timeoutMs: 15_000, bodySnippetBytes: 4_096 },
  ssrf: { blockPrivateRanges: true, allowlist: [], blocklist: [] },
});
```

### 3. 業務トランザクションの中で enqueue する

`enqueue` はトランザクションハンドルを**必須の第一引数**に取ります。`pg` ではそれが `BEGIN`/`COMMIT` を実行する `PoolClient` です。トランザクションが rollback すれば、Outbox 行も一緒に消えます。

```ts
const client = await pool.connect();
try {
  await client.query("BEGIN");

  // ... `client` 上で業務の書き込み ...
  await client.query("INSERT INTO orders (id, amount) VALUES ($1, $2)", [orderId, amount]);

  // same transaction; fail-closed
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

> 業務トランザクションが無い場合は `relay.enqueueUnsafe(input)` が独自接続で enqueue しますが、**原子性保証を失います**（それこそが本ライブラリの核心です）。本当に外側のトランザクションが存在しない場合にのみ使ってください。

> **インライン vs 登録済みエンドポイント。** 例では宛先をインライン `endpoint: { url, secret }` で渡しており、これが主経路です（secret は enqueue 時点で outbox 行にスナップショットされます）。代わりに `webhook_endpoints` の行を `endpoint: { endpointId }` で参照することもできます。v1 には**エンドポイント登録 API はありません**。該当行は自前で INSERT してください（例：`INSERT INTO webhook_endpoints (id, url, secret) VALUES (…)`）。公開されているのは `relay.endpoints.disable(id)` のみです。

### 4. dispatcher を起動する

dispatcher は配信可能な行をポーリングし、バックグラウンドで配信します。アプリのプロセス内でも専用ワーカーでも構いません。複数同時起動しても安全です。

```ts
const dispatcher = relay.createDispatcher({
  concurrency: 8,
  pollIntervalMs: 1_000,
  reclaimAfterMs: 300_000,
});

await dispatcher.start();

// シャットダウン時 — graceful: 新しい tick を止め、配信中を待ってから停止。
process.on("SIGTERM", () => void dispatcher.stop());
```

### pg の代わりに Knex を使う

```ts
import { knexStore } from "commitcourier/store/knex";

const store = knexStore({ knex });
await store.migrate();

const relay = await createRelay({ store });

await knex.transaction(async (trx) => {
  // ... `trx` 上で業務の書き込み ...
  await relay.enqueue(trx, {
    eventType: "order.created",
    payload: { orderId, amount },
    endpoint: { url: "https://customer.example.com/webhooks", secret: "whsec_..." },
  });
});
```

## 仕組み

```
┌──────────────────────────────────────────────────────────┐
│                  あなたのアプリ                          │
│                                                          │
│   業務処理 ── db.tx ──┐                                  │
│                             ▼                            │
│              relay.enqueue(trx, …)                       │  ← 同一 tx で Outbox 行を INSERT
└─────────────────────────┬────────────────────────────────┘
                          │ commit / rollback（原子的）
                          ▼
          ┌─────────────────────────────────┐
          │  PostgreSQL（既存の業務 DB）    │  ← 真実の源泉
          │  webhook_outbox                 │
          │  webhook_delivery_attempts      │
          │  webhook_endpoints（任意）      │
          └───────────────┬─────────────────┘
                          │ ポーリング（SKIP LOCKED で行を確保）
                          ▼
     ┌──────────────────────────────────────────────┐
     │  Dispatcher（バックグラウンドループ）        │  ← fail-open
     │   ├ Claim:      due な行を排他確保           │
     │   ├ SSRF Guard: 宛先 URL を検証              │
     │   ├ Signer:     Standard Webhooks 署名       │
     │   ├ HTTP:       タイムアウト付き POST        │
     │   └ Ledger:     試行を記録 → 状態遷移        │
     │                 （delivered / retry / dead） │
     └──────────────────────────────────────────────┘
                          │
                          ▼
                   外部エンドポイント
```

2 つの経路は意図的に分離されています。

- **`enqueue` は fail-closed** — 業務トランザクションに相乗りします。Outbox 行を書けないなら業務トランザクションも commit しません。（実体は安価なローカル `INSERT` で、リモート呼び出しより遥かに信頼性が高い処理です。）
- **`dispatch` は fail-open** — 配信中の配信エラーや DB エラーは業務処理に一切波及しません。ログと配信台帳に記録され、リトライ／DLQ に委ねられます。

行のライフサイクル：

```
pending ──claim──▶ in_flight ──2xx──▶ delivered
   ▲                   │
   │ 失敗 & attempts<max（available_at = now + backoff）
   └───────────────────┤
                       │ 失敗 & attempts>=max
                       ▼
                     dead（DLQ）

observe モードで enqueue ─▶ observed   （記録のみ・送信しない）
手動キャンセル           ─▶ cancelled
```

配信ワーカーが配信途中で落ちても、その行は `locked_at` が可視性タイムアウト（`reclaimAfterMs`、既定 5 分）を超えるまで `in_flight` のまま残り、次の tick が `pending` に回収します。これが **at-least-once** を担保する仕組みです。

## 設定

すべての設定は任意で、安全な既定値にマージされます。不正な値は起動時に `RelayError("CONFIG_INVALID")` で拒否され、危険だが有効な値（例：SSRF 防御の無効化）は許容されつつ logger で警告されます。

| グループ   | オプション           | 既定値                | 補足                                                               |
| ---------- | -------------------- | --------------------- | ------------------------------------------------------------------ |
|            | `mode`               | `"active"`            | `"observe"` は行を `observed` として記録し、送信しない。           |
| `signing`  | `scheme`             | `"standard-webhooks"` | Standard Webhooks のみ対応。                                       |
| `retry`    | `maxAttempts`        | `12`                  | 1 以上の整数。                                                     |
| `retry`    | `backoff`            | `"exponential"`       | `baseMs * 2^(attempts-1)`、上限あり。                              |
| `retry`    | `baseMs`             | `1000`                |                                                                    |
| `retry`    | `capMs`              | `3600000`             | `baseMs` 以上であること。                                          |
| `retry`    | `jitter`             | `0.2`                 | `0..1` の割合。thundering herd 回避のため既定 ON。                 |
| `delivery` | `timeoutMs`          | `15000`               | リクエストごとの HTTP タイムアウト。                               |
| `delivery` | `bodySnippetBytes`   | `4096`                | 台帳に保存する応答本文の先頭バイト数。                             |
| `ssrf`     | `blockPrivateRanges` | `true`                | プライベート／ループバック／リンクローカル／メタデータ IP を遮断。 |
| `ssrf`     | `allowlist`          | `[]`                  | 許可するホストパターン。                                           |
| `ssrf`     | `blocklist`          | `[]`                  | 拒否するホストパターン。                                           |

dispatcher のオプション（`relay.createDispatcher({ … })`）：

| オプション       | 既定値            | 補足                                                      |
| ---------------- | ----------------- | --------------------------------------------------------- |
| `concurrency`    | `8`               | 最大同時配信数。                                          |
| `pollIntervalMs` | `1000`            | アイドル時のポーリング間隔。満杯バッチ時は即座に再 tick。 |
| `reclaimAfterMs` | `300000`          | 可視性タイムアウト。これを超えた `in_flight` 行を回収。   |
| `batchSize`      | `concurrency * 2` | 1 tick で確保する行数。                                   |

**段階導入**：まず `mode: "observe"` で「送るはず」の量と宛先を記録し、想定と差分確認してから `"active"` に切り替えます。

**署名 secret の形式**：`whsec_` プレフィックス付きの secret は Standard Webhooks の慣例どおり Base64 とみなして raw 鍵バイトにデコードします。それ以外の文字列は raw UTF-8 バイトとして使われます。

## 運用

```ts
// 1 つの outbox 行の配信台帳（全試行・応答・所要時間）。
const attempts = await relay.attempts({ outboxId });

// リプレイ：新しい pending コピーとして再 enqueue。ID 指定…
const { ids } = await relay.replay({ outboxId });
// …またはフィルタ指定（例：特定時刻以降の dead 全件）：
await relay.replay({ filter: { status: "dead", since: new Date(Date.now() - 86_400_000) } });

// 登録済みエンドポイントを無効化。
await relay.endpoints.disable(endpointId);

// graceful シャットダウン。
await dispatcher.stop();
```

### ロギングと可観測性

dispatch 経路は **fail-open** です。配信・claim・reclaim の失敗は throw されず、**logger** に送られます。その logger は**既定で no-op** です。logger を注入しないと配信障害は無音になります。本番では必ず注入してください。

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

logger は、危険だが有効な設定（例：SSRF 防御の無効化）に対する起動時警告も出します。`clock?: () => Date` も注入でき、決定的なテストに便利です。（構造化トレーシング／OpenTelemetry は v2 ロードマップ。）

### データ保持

CommitCourier は行を自動削除しません。`webhook_outbox`（`delivered`/`dead` 行を含む）と `webhook_delivery_attempts` は時間とともに増えるため、定期的なプルーニングは利用者側で行ってください（例：保持期間を超えた `delivered` の outbox 行を削除）。outbox 行を削除すると、その配信台帳も連動して削除されます（`ON DELETE CASCADE`）。

### DLQ（`dead` 行）の調査

v1 が提供する `replay({ filter })` は該当行を**再 enqueue**（書き込み）します。読み取り専用の「dead 行一覧」API はまだ無いため、リプレイ前に DLQ を調査するにはテーブルを直接参照してください。

```sql
SELECT id, event_type, attempts, last_error, created_at
FROM webhook_outbox
WHERE status = 'dead'
ORDER BY created_at DESC;
```

## エラーハンドリング

ライブラリが throw するエラーはすべて `RelayError` で、安定した機械可読の `code` を持ちます。

| code                 | 発生元                         | 意味                                                       |
| -------------------- | ------------------------------ | ---------------------------------------------------------- |
| `CONFIG_INVALID`     | `createRelay`（起動時）        | 設定が不正（fail-fast）。                                  |
| `MISSING_TABLES`     | `createRelay`（起動時）        | コアテーブルが存在しない。`store.migrate()` を実行。       |
| `ENQUEUE_NO_TARGET`  | `enqueue` / `enqueueUnsafe`    | `{ url, secret }` も `{ endpointId }` も指定されていない。 |
| `SSRF_BLOCKED`       | dispatch（throw せず台帳記録） | 宛先が遮断レンジに解決された。                             |
| `ENDPOINT_NOT_FOUND` | dispatch（throw せず台帳記録） | `endpointId` が未登録。                                    |
| `ENDPOINT_DISABLED`  | dispatch（throw せず台帳記録） | 登録済みエンドポイントが無効化されている。                 |
| `MISSING_SECRET`     | dispatch（throw せず台帳記録） | inline 宛先に署名用の secret スナップショットが無い。      |

この区別はアーキテクチャを反映しています。**enqueue 経路**のエラーは _throw_ され、トランザクションを rollback させます（fail-closed）。一方 **dispatch 経路**の失敗は *配信台帳に記録*されてリトライされ、アプリには throw されません（fail-open）。後者は `relay.attempts({ outboxId })` で確認します。

## 署名の検証（受信側）

各配信は次のヘッダを付けて JSON を POST します。

| ヘッダ              | 値                                                             |
| ------------------- | -------------------------------------------------------------- |
| `webhook-id`        | outbox 行の id（署名のメッセージ ID）。                        |
| `webhook-timestamp` | Unix 秒。                                                      |
| `webhook-signature` | `{id}.{timestamp}.{body}` に対する `v1,<base64 HMAC-SHA256>`。 |
| `content-type`      | `application/json`。                                           |
| `idempotency-key`   | enqueue 時に指定した場合のみ付与。                             |

これは [Standard Webhooks](https://www.standardwebhooks.com/) の慣例なので、受信側は互換の検証ライブラリでそのまま検証できます。CommitCourier は独自署名方式を作りません。

## 保証と非目標

**保証すること**

- dual-write による幻の／消えた webhook が起きない — Outbox 行が業務トランザクションと原子的。
- プロセスクラッシュでイベントを失わない — 可視性タイムアウト回収による at-least-once。
- 複数インスタンスでの二重配信が起きない — `FOR UPDATE SKIP LOCKED`。
- 改ざん・なりすましの検出 — Standard Webhooks 署名。
- outbound SSRF を既定で遮断。

**非目標（正直に明記）**

- 受信側での **exactly-once な「効果」**。提供するのは at-least-once ＋ idempotency key であり、最終的な重複排除は受信側の責務です。
- エンドポイント横断の**全順序保証**。既定は順不同です（エンドポイント単位 FIFO は将来の任意機能）。
- **無限スケール**。既存 Postgres 上の中〜中規模を正直な対象とし、billions/sec 級は対象外です。
- **鍵の保管時暗号化**。これは DB 側の責務です（任意の暗号化カラム対応は将来）。
- インバウンド webhook の受信・検証、および顧客向け管理ポータル UI。

## CommitCourier の取り外し

CommitCourier は非侵襲かつ可逆です。すべては 3 つの専用テーブル（`webhook_outbox` / `webhook_delivery_attempts` / `webhook_endpoints`）に隔離されています。dispatcher を止め、`enqueue` 呼び出しを外し、これらのテーブルを drop すれば、業務スキーマには一切手を加えずに撤去できます。

## 公開 API

| import                     | エクスポート                                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `commitcourier`            | `createRelay`、`Relay`/`RelayInit` 型、`Store` ポート、全ドメイン型。                                                                                                    |
| `commitcourier/core`       | 純粋・依存ゼロのドメイン層（`sign`、`backoffMs`、状態遷移、SSRF ヘルパ、`resolveConfig`、`RelayError`、型）。import してもドライバや `node:*` 組込みを一切引き込まない。 |
| `commitcourier/store/pg`   | `postgresStore({ pool })` — `Store<PoolClient>`。                                                                                                                        |
| `commitcourier/store/knex` | `knexStore({ knex })` — `Store<Knex.Transaction>`。                                                                                                                      |

主要シグネチャ：

```ts
function createRelay<TTx>(init: RelayInit<TTx>): Promise<Relay<TTx>>;

interface Relay<TTx> {
  enqueue(trx: TTx, input: EnqueueInput): Promise<{ id: string }>;
  enqueueUnsafe(input: EnqueueInput): Promise<{ id: string }>;
  createDispatcher(options?: DispatcherOptions): Dispatcher;
  attempts(opts: { outboxId: string }): Promise<DeliveryAttempt[]>;
  replay(opts: { outboxId: string } | { filter: ReplayFilter }): Promise<{ ids: string[] }>;
  endpoints: { disable(endpointId: string): Promise<void> };
}
```

## ステータスとロードマップ

- **v1（現行）**：Postgres ストア、`pg` ＋ Knex アダプタ、トランザクショナル enqueue、ポーラー型 dispatcher（外部キュー不要）、Standard Webhooks 署名（単一鍵）、リトライ／バックオフ／ジッター／DLQ、配信台帳、ID 指定リプレイ、SSRF 防御、観測モード。
- **v1.1**：Drizzle / Prisma アダプタ、鍵ローテーション（二重署名）、エンドポイント単位 FIFO、`Retry-After` 尊重。
- **v2**：任意の BullMQ アクセラレータ・アダプタ（Outbox 行は引き続き真実の源泉）、エンドポイント登録の管理 API、OpenTelemetry フック。

## セキュリティ

脆弱性を見つけた場合は、**公開 Issue を作成せず**、**[セキュリティポリシー](./SECURITY.ja.md)**に従って非公開で報告してください。同ドキュメントはセキュリティモデル（SSRF の既定、署名、secret の取り扱い）と、対象／対象外の範囲も説明しています。

## ライセンス

[MIT](./LICENSE)
