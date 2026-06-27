# CommitCourier

> 既存の PostgreSQL だけで動く、Node.js / TypeScript 向けのトランザクショナル Outbound Webhook 配信ライブラリ。

[![npm version](https://img.shields.io/npm/v/commitcourier.svg)](https://www.npmjs.com/package/commitcourier)
[![license](https://img.shields.io/github/license/Y1-Effy/CommitCourier)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.19-brightgreen)](https://nodejs.org)

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
- **リプレイ** — ID 指定、またはフィルタ指定（例：特定時刻以降の `dead` 全件）で再 enqueue。安全上限を内蔵し、広いリプレイが無制限な大量再送に膨らみません。
- **キャンセル** — 未送信の行を送信前に止める（`relay.cancel(id)`）。送信済み／配信中の行は変更しません。
- **サーバーレス／cron 対応** — `relay.dispatchOnce()` がキューを 1 回ドレインして返すので、常駐プロセス無しに Lambda や cron tick から配信できます。
- **エンドポイント回路遮断** — 連続失敗が N 回に達した登録エンドポイントを任意で自動 disable し、恒久ダウン宛先が DLQ を埋め続けるのを防止。
- **組込みの保持/削除** — `relay.prune({ olderThan })` が古い終端行をバッチ削除（アクティブ行は対象外）。テーブルの無限肥大を防止。
- **SSRF 防御は既定 ON** — プライベート／ループバック／リンクローカル／クラウドメタデータ宛先を遮断。
- **複数インスタンスでの単一配信**を `FOR UPDATE SKIP LOCKED` で担保。可視性タイムアウト回収で at-least-once。
- **観測（observe）モード** — 実送信せずに「送るはずの内容」を記録し、安全に段階導入。
- **任意の保管時暗号化** — `cipher`（組込みの WebCrypto AES-256-GCM ヘルパ、または独自の KMS/Vault アダプタ）を渡すと、`secret_snapshot`／エンドポイント secret を DB 上で暗号文として保持。

## インストール

```bash
npm install commitcourier
# 使うドライバを追加（optional peer dependency）：
npm install pg      # または: npm install knex
```

**動作要件**：Node.js **22.19.0 以上**、**PostgreSQL 12 以上**（`FOR UPDATE SKIP LOCKED` が使えれば 9.5 以上で動作）。**ESM/CJS** デュアルビルドと TypeScript 型定義を同梱します。`pg` と `knex` は **optional peer dependency** です。使う方だけをインストールしてください。

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

> **インライン vs 登録済みエンドポイント。** 例では宛先をインライン `endpoint: { url, secret }` で渡しており、これが主経路です（secret は enqueue 時点で outbox 行にスナップショットされます）。代わりに `webhook_endpoints` の行を `endpoint: { endpointId }` で参照することもできます。これらの行は `relay.endpoints` 管理 API（`register({ url, secret, … })` / `update` / `enable` / `disable` / `get`）で管理できます。

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

| グループ   | オプション           | 既定値                | 補足                                                                                 |
| ---------- | -------------------- | --------------------- | ------------------------------------------------------------------------------------ |
|            | `mode`               | `"active"`            | `"observe"` は行を `observed` として記録し、送信しない。                             |
| `signing`  | `scheme`             | `"standard-webhooks"` | Standard Webhooks のみ対応。                                                         |
| `retry`    | `maxAttempts`        | `12`                  | 1 以上の整数。                                                                       |
| `retry`    | `backoff`            | `"exponential"`       | `baseMs * 2^(attempts-1)`、上限あり。                                                |
| `retry`    | `baseMs`             | `1000`                |                                                                                      |
| `retry`    | `capMs`              | `3600000`             | `baseMs` 以上であること。                                                            |
| `retry`    | `jitter`             | `0.2`                 | `0..1` の割合。thundering herd 回避のため既定 ON。                                   |
| `delivery` | `timeoutMs`          | `15000`               | リクエストごとの HTTP タイムアウト。                                                 |
| `delivery` | `bodySnippetBytes`   | `4096`                | 台帳に保存する応答本文の先頭バイト数。                                               |
| `delivery` | `keepAliveTimeoutMs` | `10000`               | undici keep-alive 窓。長くすると同一宛先への連続配信で TCP/TLS を再利用。            |
| `delivery` | `connections`        | _(undici 既定)_       | オリジンあたりの同時接続数の上限（任意）。                                           |
| `ssrf`     | `blockPrivateRanges` | `true`                | プライベート／ループバック／リンクローカル／メタデータ IP を遮断。                   |
| `ssrf`     | `allowlist`          | `[]`                  | 許可するホストパターン。                                                             |
| `ssrf`     | `blocklist`          | `[]`                  | 拒否するホストパターン。                                                             |
|            | `endpointCacheTtlMs` | `0`（無効）           | 登録エンドポイント検索の in-process キャッシュ TTL（ms）。「性能チューニング」参照。 |

dispatcher のオプション（`relay.createDispatcher({ … })`）：

| オプション       | 既定値            | 補足                                                                                                      |
| ---------------- | ----------------- | --------------------------------------------------------------------------------------------------------- |
| `concurrency`    | `8`               | 最大同時配信数。                                                                                          |
| `pollIntervalMs` | `1000`            | アイドル時の待機の上限。アイドル時は約 50ms からこの値まで指数バックオフし、満杯バッチ時は即座に再 tick。 |
| `reclaimAfterMs` | `300000`          | 可視性タイムアウト。これを超えた `in_flight` 行を回収。                                                   |
| `batchSize`      | `concurrency * 2` | 1 tick で確保する行数。                                                                                   |

### 性能チューニング

スループットは dispatcher に十分な余地を与えるかが要点です。

- **並行度とプールサイズ。** `concurrency` を上げる効果は `pg.Pool` に空き接続がある場合のみ。dispatch 経路は in-flight な `claimDue` / `completeAttempt` ごとに 1 接続を使います。`Pool({ max })` は `concurrency` ＋ 余裕以上にしないと、配信がプール待ちで止まります。
- **バッチと接続。** `batchSize`（既定 `concurrency * 2`）は in-flight バッファ上限、`delivery.connections` は宛先あたりの接続上限。負荷に合わせて調整し、同一ホストへ多数配信するなら `delivery.keepAliveTimeoutMs` を延ばします。
- **登録エンドポイントのキャッシュ。** 登録エンドポイント運用では配信ごとに DB を引きます。`endpointCacheTtlMs`（例 `1000`〜`5000`）で in-process キャッシュ。`update`/`disable` は同一プロセス内で即時無効化し、TTL が他プロセスの変更の鮮度遅延の上限になります。inline `{ url, secret }` 運用には影響しません。**複数の dispatcher プロセス**では、`endpointCacheTtlMs` は `disable` や鍵ローテーション後に他プロセスが古いエンドポイントで配信し続ける時間の上限にもなります。短めに設定し、secret をローテーションする際は最後の配信から `ttlMs` 以上空けてから `finalizeRotation` を呼んでください（それまでは他プロセスが旧鍵のみで署名し続ける可能性があります）。
- **インデックスは組込み。** claim/reclaim クエリは `pending` / `in_flight` 行のみの部分インデックスを使うため、delivered/dead 行が増えても高速なまま（調整不要）。

**段階導入**：まず `mode: "observe"` で「送るはず」の量と宛先を記録し、想定と差分確認してから `"active"` に切り替えます。

**署名 secret の形式**：`whsec_` プレフィックス付きの secret は Standard Webhooks の慣例どおり Base64 とみなして raw 鍵バイトにデコードします。それ以外の文字列は raw UTF-8 バイトとして使われます。

**保管時の secret 暗号化**：`createRelay({ store, cipher })` に `cipher` を渡すと、署名 secret は DB 上で暗号文になります。組込みの `createAesGcmCipher(key)`（WebCrypto AES-256-GCM。鍵は `generateSecretKey()` で生成可）、または KMS/Vault 上の独自 `SecretCipher` を使えます。鍵の管理は利用者責務で、`cipher` 未指定なら secret は平文のまま保存されます。

## 運用

```ts
// 1 つの outbox 行の配信台帳（全試行・応答・所要時間）。
const attempts = await relay.attempts({ outboxId });

// 1 行を参照（読み取り専用・secret 非露出）。不明な id は null。
const row = await relay.get(outboxId);

// 未送信の行をキャンセル。既にクレーム済み／送信済み／不明な場合は { cancelled: false }。
const { cancelled } = await relay.cancel(outboxId);

// リプレイ：新しい pending コピーとして再 enqueue。ID 指定…
const { ids } = await relay.replay({ outboxId });
// …またはフィルタ指定（例：特定時刻以降の dead 全件）。選択は安全のため上限でクランプされる：
const res = await relay.replay({ filter: { status: "dead", since: new Date(Date.now() - 86_400_000) } });
// `res.capped === true` は上限で打ち切られた印（全件は再送されていない）。さらに replay するには
// フィルタを絞る（`endpointId` やより狭い `since`）か `filter.limit` を上げる。同一フィルタでループしては
// いけない：replay は元行を変更しない（dead は dead のまま）ので、同じ先頭行を再選択して重複再送になる。

// 登録済みエンドポイントを無効化。
await relay.endpoints.disable(endpointId);

// graceful シャットダウン。
await dispatcher.stop();
```

### サーバーレス／cron 配信（1 回実行）

常駐 Dispatcher を持てない場合（AWS Lambda・cron・スケジュールタスク）、ループの代わりにキューを 1 回ドレインして返します：

```ts
// 滞留ロックを回収し、due 行を波状にクレーム（concurrency/batchSize/ordering を尊重）して配信し、
// キューが空（または maxRows 到達）になったら解決します。
const { processed } = await relay.dispatchOnce({ concurrency: 8 }, { maxRows: 500 });
```

`dispatchOnce` はその実行で配信した行数を返します。連続ループ（`createDispatcher().start()`）の稼働中は拒否します — どちらか一方のモデルを使ってください。

### 失敗エンドポイントの自動 disable（回路遮断）

恒久ダウンの登録エンドポイントは、放置すると各行が retry budget を使い切って DLQ に落ちるまで配信（と失敗）を受け続けます。回路遮断を有効にすると、連続 N 回失敗で自動 disable します（成功で counter リセット）：

```ts
const relay = await createRelay({ store, circuitBreaker: { failureThreshold: 20 } });
```

既定の `failureThreshold: 0` は無効。登録エンドポイント経路のみに適用（インライン `{ url, secret }` には disable 対象が無い）、fail-open で、再有効化は通常の `relay.endpoints.enable(endpointId)` です。

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

logger は、危険だが有効な設定（例：SSRF 防御の無効化）に対する起動時警告も出します。`clock?: () => Date` も注入でき、決定的なテストに便利です。

### OpenTelemetry（トレース＆メトリクス）

任意の `commitcourier/otel` アダプタ（v1.2）が、配信を OpenTelemetry の span とメトリクスに対応づけます。`@opentelemetry/api` を optional peer dependency として参照するため、メインエントリが OTel を巻き込むことはありません。結果を `createRelay` に渡します。

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

各配信試行は、secret を含まない属性（`webhook.id`・`webhook.event_type`・`webhook.attempt`・`http.response.status_code`・`server.address` / `server.port`・`endpoint.id`）を持つ CLIENT span を 1 本発行します。同じ結果で `commitcourier.deliveries` カウンター（`outcome = delivered | retry | dead`）と `commitcourier.delivery.duration` ヒストグラムを記録します。このシームは fail-open で、計装エラーはログして握りつぶし、dispatcher を止めません。低レベル用途では OTel なしで独自の `instrument` / `hooks` を渡せます。

カウンターとヒストグラムは**配信試行ごと**に記録されます（リトライは都度カウント、ワーカークラッシュ後の希少な再配信も含む）。ユニーク行数ではなく試行回数です。

### 低遅延配信（アクセラレータ）

既定の Dispatcher はポーリングするため、静かなキューに enqueue された行は配信開始まで最大 `pollIntervalMs` 待ちます。任意の**アクセラレータ（v2）**はこの待機を短絡し、enqueue ごとに購読中の Dispatcher を起こして near-immediate に配信を始めます。Outbox 行は引き続き唯一の真実の源泉で、通知喪失時も配信が遅れるだけ（ポーラーが回収）なので、正当性・可用性には一切影響しません。

第一実装の `commitcourier/accelerator/pg` は Postgres LISTEN/NOTIFY を使い、追加インフラ不要です。`NOTIFY` は enqueue トランザクションに相乗りするため、行が可視になる前に listener が起きることはありません。LISTEN は自己修復する専用接続で実行されます。

```ts
import { Pool, Client } from "pg";
import { createRelay } from "commitcourier";
import { postgresStore } from "commitcourier/store/pg";
import { createPgAccelerator } from "commitcourier/accelerator/pg";

const pool = new Pool(/* … */);
const accelerator = createPgAccelerator({
  pool,
  // LISTEN 専用接続（delivery プールから取ってはいけない）:
  listen: async () => {
    const c = new Client(/* … */);
    await c.connect();
    return c;
  },
});

const relay = await createRelay({ store: postgresStore({ pool }), accelerator });
// この relay が生成する各 Dispatcher は enqueue で起床します:
relay.createDispatcher({ pollIntervalMs: 10_000 }).start();
```

必要な peer は `pg` のみ（`pg` ストアで既に必須）。BullMQ アクセラレータは同じ `Accelerator` シーム上の将来アダプタです。

運用上の注意 2 点：(1) トランザクショナル wake は enqueue トランザクションに相乗りするため、稀に `NOTIFY` 自体が失敗すると `enqueue`／`enqueueMany` は業務書き込みごと rollback します（fail-closed）。`enqueueUnsafe` は握ります。(2) LISTEN 接続がエラーを表に出さず劣化した場合、wake は取りこぼされ配信はポーリング（`pollIntervalMs` 上限）にフォールバックします。poller が真実の源泉なので正当性には影響しません。

### データ保持

CommitCourier は行を自動削除しません。`webhook_outbox`（`delivered`/`dead`/`cancelled` 行を含む）と `webhook_delivery_attempts` は時間とともに増えるため、定期的なプルーニングが必要です。組込みの `relay.prune(...)` を cron／スケジュールジョブから使えます：

```ts
// 30 日より古い終端行をバッチ削除。配信台帳は連動削除。
const cutoff = new Date(Date.now() - 30 * 86_400_000);
let res = await relay.prune({ olderThan: cutoff });
while (res.deleted === 10_000) res = await relay.prune({ olderThan: cutoff }); // 残りが無くなるまでページング
```

`prune` は**非アクティブ**ステータスのみ削除します（既定 `delivered`／`dead`／`cancelled`。`statuses` で絞り込み、または `observed` を含めることも可能）。`pending`／`in_flight` の行は**決して削除されません**（渡すと `INVALID_ARGUMENT`）。1 回の呼び出しは `limit`（既定 10,000・上限 100,000）で上限化され `{ deleted }` を返すので、limit と一致する間は再度呼んで消し切れます。outbox 行を削除するとその配信台帳も連動削除されます（`ON DELETE CASCADE`）。従来どおり生 SQL での prune も可能です。

## CLI：`commitcourier doctor`

ローカル開発と CI 向けのレディネス診断。DB（スキーマ・適用済みマイグレーション・配信インデックス・キュー健全性）と設定（どの項目が既定のままか、推奨だが未設定の項目とその理由、リスク設定）を点検します：

```sh
# DB ＋ 設定レディネス（$DATABASE_URL を使用。DB 検査には pg peer dep が必要）：
npx commitcourier doctor

# 設定のみ（DB なし）／特定の設定ファイルを検査／機械可読出力：
npx commitcourier doctor --skip-db
npx commitcourier doctor --config ./commitcourier.config.js   # 部分設定を default export
npx commitcourier doctor --json
```

コアテーブル欠落や設定不正のとき非ゼロ終了するので、デプロイのゲートに使えます。出力例（抜粋）：

```text
Database
  [ ok ] core tables present
  [warn] pending migrations: 002_… — run migrate()
  [ ok ] dispatch indexes present
  [info] queue: pending=3 in_flight=0 delivered=120 dead=2 …
  [warn] 2 dead rows in the DLQ
Configuration
  [warn] logger: unset — the default logger is a no-op, so delivery/claim errors are SILENT in production
  [info] circuitBreaker.failureThreshold: 0 — failing endpoints are never auto-disabled
[ !! ] doctor: problems found (see above)
```

### DLQ（`dead` 行）の調査

読み取り専用の `relay.list({ filter })` API（v1.2）で、リプレイ前に dead 行を調査できます。単調増加の `seq` による新しい順・キーセットページングで、secret を含まない行を返します。選んだ行を `replay({ filter })` で**再 enqueue**（書き込み）します。

```ts
// DLQ の最初のページ（新しい順）。
const { items, nextCursor } = await relay.list({ status: "dead", limit: 100 });
for (const r of items) {
  console.log(r.id, r.eventType, r.attempts, r.lastError);
}
// 次のページ（nextCursor が非 null のとき）。
if (nextCursor) await relay.list({ status: "dead", limit: 100, cursor: nextCursor });
```

`list` は `{ status, since, endpointId, limit, cursor }` を受け取り、署名鍵スナップショットは決して返しません。（生 SQL で `webhook_outbox` を直接参照しても構いません。）

> **replay は対象を絞る。** `replay({ filter })` は一致した全行を選択し、コピーを単一トランザクションで INSERT します。巨大な DLQ ではメモリ上の結果が大きくなり長時間トランザクションになるため、`since` や `endpointId` でフィルタを絞り、数十万行を一度に再 enqueue せず分割して replay してください。

## エラーハンドリング

ライブラリが throw するエラーはすべて `RelayError` で、安定した機械可読の `code` を持ちます。

| code                 | 発生元                         | 意味                                                             |
| -------------------- | ------------------------------ | ---------------------------------------------------------------- |
| `CONFIG_INVALID`     | `createRelay`（起動時）        | 設定が不正（fail-fast）。                                        |
| `MISSING_TABLES`     | `createRelay`（起動時）        | コアテーブルが存在しない。`store.migrate()` を実行。             |
| `ENQUEUE_NO_TARGET`  | `enqueue` / `enqueueUnsafe`    | `{ url, secret }` も `{ endpointId }` も指定されていない。       |
| `INVALID_ARGUMENT`   | `list` / `endpoints.list`      | 一覧フィルタが不正（例：数値でない `cursor`、未知の `status`）。 |
| `SSRF_BLOCKED`       | dispatch（throw せず台帳記録） | 宛先が遮断レンジに解決された。                                   |
| `ENDPOINT_NOT_FOUND` | dispatch（throw せず台帳記録） | `endpointId` が未登録。                                          |
| `ENDPOINT_DISABLED`  | dispatch（throw せず台帳記録） | 登録済みエンドポイントが無効化されている。                       |
| `MISSING_SECRET`     | dispatch（throw せず台帳記録） | inline 宛先に署名用の secret スナップショットが無い。            |

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

> **body の正規化。** `payload` は Postgres `jsonb` で保存されるため、配信 body は enqueue した値の JSON ラウンドトリップになります（オブジェクトのキー順は非保持、重複キーは畳み込み、意味のない空白は除去）。署名は常に「実際に送るバイト列」に対して計算されるので、これが原因で検証が失敗することはありません。ただし配信バイト列が入力と完全一致する保証はありません。バイト厳密が必要なら payload を事前シリアライズ済みの文字列として enqueue してください。

## 保証と非目標

**保証すること**

- dual-write による幻の／消えた webhook が起きない — Outbox 行が業務トランザクションと原子的。
- プロセスクラッシュでイベントを失わない — 可視性タイムアウト回収による at-least-once。
- 複数インスタンスでの二重配信が起きない — `FOR UPDATE SKIP LOCKED`。
- 改ざん・なりすましの検出 — Standard Webhooks 署名。
- outbound SSRF を既定で遮断。

**非目標（正直に明記）**

- 受信側での **exactly-once な「効果」**。提供するのは at-least-once ＋ idempotency key であり、最終的な重複排除は受信側の責務です。
- エンドポイント横断の**全順序保証**。既定は順不同です（エンドポイント単位 FIFO はオプトインで提供：`createDispatcher({ ordering: "per-endpoint" })`）。
- **無限スケール**。既存 Postgres 上の中〜中規模を正直な対象とし、billions/sec 級は対象外です。
- **暗号鍵の管理**。署名 secret は `cipher` 設定で保管時暗号化できますが（「設定」参照）、鍵自体の保管・配布・ローテーションは利用者の責務です。`cipher` 未設定時の保管時暗号化は DB 側の責務です。
- インバウンド webhook の受信・検証、および顧客向け管理ポータル UI。

## CommitCourier の取り外し

CommitCourier は非侵襲かつ可逆です。すべては 3 つの専用テーブル（`webhook_outbox` / `webhook_delivery_attempts` / `webhook_endpoints`）に隔離されています。dispatcher を止め、`enqueue` 呼び出しを外し、これらのテーブルを drop すれば、業務スキーマには一切手を加えずに撤去できます。

## 公開 API

| import                         | エクスポート                                                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `commitcourier`                | `createRelay`、`Relay`/`RelayInit` 型、`Store` ポート、全ドメイン型。                                                                                                    |
| `commitcourier/core`           | 純粋・依存ゼロのドメイン層（`sign`、`backoffMs`、状態遷移、SSRF ヘルパ、`resolveConfig`、`RelayError`、型）。import してもドライバや `node:*` 組込みを一切引き込まない。 |
| `commitcourier/store/pg`       | `postgresStore({ pool })` — `Store<PoolClient>`。                                                                                                                        |
| `commitcourier/store/knex`     | `knexStore({ knex })` — `Store<Knex.Transaction>`。                                                                                                                      |
| `commitcourier/accelerator/pg` | `createPgAccelerator({ pool, listen })` — Postgres LISTEN/NOTIFY による任意の低遅延 wake。`createRelay({ accelerator })` に渡す。                                        |

主要シグネチャ：

```ts
function createRelay<TTx>(init: RelayInit<TTx>): Promise<Relay<TTx>>;

interface Relay<TTx> {
  enqueue(trx: TTx, input: EnqueueInput): Promise<{ id: string }>;
  enqueueMany(trx: TTx, inputs: EnqueueInput[]): Promise<{ ids: string[] }>;
  enqueueUnsafe(input: EnqueueInput): Promise<{ id: string }>;
  createDispatcher(options?: DispatcherOptions): Dispatcher;
  dispatchOnce(options?: DispatcherOptions, runOptions?: RunOnceOptions): Promise<{ processed: number }>;
  attempts(opts: { outboxId: string }): Promise<DeliveryAttempt[]>;
  replay(opts: { outboxId: string } | { filter: ReplayFilter }): Promise<{ ids: string[]; capped: boolean }>;
  cancel(outboxId: string): Promise<{ cancelled: boolean }>;
  get(outboxId: string): Promise<OutboxListItem | null>;
  list(filter?: OutboxListFilter): Promise<Page<OutboxListItem>>;
  prune(opts: PruneOptions): Promise<{ deleted: number }>; // 保持：古い終端行を削除
  stats(): Promise<OutboxStats>;
  endpoints: EndpointAdmin; // register / update / enable / disable / get / list
}
```

## ステータスとロードマップ

- **v1（現行）**：Postgres ストア、`pg` ＋ Knex アダプタ、トランザクショナル enqueue、ポーラー型 dispatcher（外部キュー不要）、Standard Webhooks 署名（単一鍵）、リトライ／バックオフ／ジッター／DLQ、配信台帳、ID 指定リプレイ、SSRF 防御、観測モード、登録エンドポイント管理 API（`register` / `update` / `enable` / `disable` / `get`）、任意の保管時 secret 暗号化（`cipher`）、スループット調整（claim/reclaim の部分インデックス、undici keep-alive、任意の登録エンドポイントキャッシュ、適応ポーリング）。
- **v1.1**：鍵ローテーション／二重署名（`endpoints.rotateSecret` / `finalizeRotation`）、`Retry-After` 尊重、`410 Gone` での即時エンドポイント無効化、オプトインのエンドポイント単位 FIFO（`createDispatcher({ ordering: "per-endpoint" })`）、Drizzle（`commitcourier/store/drizzle`）＋ Prisma（`commitcourier/store/prisma`）アダプタ。
- **v1.2**：読み取り専用の DLQ／outbox 一覧 API（`relay.list({ status: "dead", … })`、secret 非露出・seq キーセットページング）、エンドポイント一覧（`endpoints.list({ status, … })`）、OpenTelemetry アダプタ（`commitcourier/otel` — 配信ごとの span ＋ outcome カウンター／duration ヒストグラム。fail-open な `instrument` / `hooks` シーム経由）。
- **v2**：低遅延配信アクセラレータ（汎用 `Accelerator` シーム＋ Postgres LISTEN/NOTIFY 実装 `commitcourier/accelerator/pg`。Outbox 行は引き続き真実の源泉）、スキーマバージョン管理テーブル（`commitcourier_migrations` ＋ 増分 `migrate()`）。BullMQ アクセラレータとさらなるエンドポイント管理 API は同じシーム上の将来課題。
- **v2.1**：運用性 — 未送信行のキャンセル（`relay.cancel`）、サーバーレス／cron 向け 1 回実行（`relay.dispatchOnce` / `dispatcher.runOnce`）、単一行取得（`relay.get`）、リプレイ安全上限（`replay` は `{ ids, capped }` を返す）、オプトインのエンドポイント回路遮断（`createRelay({ circuitBreaker: { failureThreshold } })`）、組込みの保持/削除（`relay.prune({ olderThan })`）。

## セキュリティ

脆弱性を見つけた場合は、**公開 Issue を作成せず**、**[セキュリティポリシー](./SECURITY.ja.md)**に従って非公開で報告してください。同ドキュメントはセキュリティモデル（SSRF の既定、署名、secret の取り扱い）と、対象／対象外の範囲も説明しています。

## ライセンス

[MIT](./LICENSE)
