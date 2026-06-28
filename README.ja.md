# CommitCourier

> 既存の PostgreSQL だけで動く、Node.js / TypeScript 向けのトランザクショナル Outbound Webhook 配信ライブラリ。

[![CI](https://github.com/Y1-Effy/CommitCourier/actions/workflows/ci.yml/badge.svg)](https://github.com/Y1-Effy/CommitCourier/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/commitcourier.svg)](https://www.npmjs.com/package/commitcourier)
[![license](https://img.shields.io/github/license/Y1-Effy/CommitCourier)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.19-brightgreen)](https://nodejs.org)

🇬🇧 English: **[README.md](./README.md)**（こちらがメインです） · 🔒 [セキュリティポリシー](./SECURITY.ja.md)

CommitCourier は、既存の Node.js / TypeScript アプリに信頼性のある Outbound Webhook を**後付け**するライブラリです。フレームワーク非依存で、**追加インフラは不要**（すでに動かしている Postgres だけ）。webhook の `enqueue` を**あなた自身の業務トランザクションの中**で行うため、業務の書き込みと原子的に commit / rollback されます。バックグラウンドの dispatcher が、その後を Standard Webhooks 署名・リトライ・DLQ・配信台帳・SSRF 防御・複数インスタンスでの単一配信まで一貫して担います。

> ⚠️ **プレリリース**（`v0.2.0`）です。API およびパッケージ名は `1.0.0` までに変更される可能性があります。

---

## 目次

- [なぜ必要か](#なぜ必要か)
- [クイックスタート](#クイックスタート)
- [ユースケース](#ユースケース)
- [比較](#比較)
- [特長](#特長)
- [仕組み](#仕組み)
- [設定](#設定)
- [運用](#運用)
- [CLI：`commitcourier doctor`](#clicommitcourier-doctor)
- [エラーハンドリング](#エラーハンドリング)
- [署名の検証（受信側）](#署名の検証受信側)
- [保証と非目標](#保証と非目標)
- [マイグレーション](#マイグレーション)
- [CommitCourier の取り外し](#commitcourier-の取り外し)
- [公開 API](#公開-api)
- [機能の安定度](#機能の安定度)
- [互換性とサポート](#互換性とサポート)
- [ロードマップ](#ロードマップ)
- [セキュリティ](#セキュリティ)
- [ライセンス](#ライセンス)

## なぜ必要か

業務状態の更新と webhook 送信は別のアクションです。その間でクラッシュや rollback が起きると、**dual-write（二重書き込み）不整合**が発生します。

- **幻の Webhook** — 先に webhook を enqueue → 業務トランザクションが rollback。存在しない注文の `order.created` が顧客に届く。
- **消えた Webhook** — 先に業務トランザクションを commit → enqueue 直前にプロセスが停止。注文は確定したのに通知が永久に飛ばない。

一般的な手段の多くはこれを構造的に解けません。SaaS 型（Svix / Outpost）や Redis 型キュー（BullMQ）は、**ローカル DB トランザクションに入れられないリモート系**へ enqueue します。ブローカー Outbox 系ライブラリは業務トランザクションに相乗りできますが、配信先は**メッセージブローカー**であり、HTTP webhook 配信・署名・SSRF 防御・配信台帳を持ちません。

CommitCourier は、**あなた自身の DB トランザクションに相乗りし**、その先を **webhook-grade の HTTP 配信**まで運ぶ埋め込み型ライブラリです。Outbox 行が業務変更と同一トランザクションで書かれるため、dual-write 不整合は**定義上起きません**。

## クイックスタート

使うドライバとあわせてパッケージをインストールします：

```bash
npm install commitcourier
# 使うドライバを追加（optional peer dependency）：
npm install pg      # または: npm install knex
```

**動作要件**：Node.js **22.19.0 以上**、**PostgreSQL 12 以上**（最低サポートバージョン。DDL は `GENERATED ALWAYS AS IDENTITY` と `FOR UPDATE SKIP LOCKED` を使用）。CI の integration テストは **PostgreSQL 16** に対して実行しています。**ESM/CJS** デュアルビルドと TypeScript 型定義を同梱します。`pg` と `knex` は **optional peer dependency** です。使う方だけをインストールしてください。

### 1. テーブルを作成する

`migrate()` は冪等な DDL を適用します — 業務 3 テーブル（`webhook_outbox` / `webhook_delivery_attempts` / `webhook_endpoints`）に加え、適用済みマイグレーションを追跡する `commitcourier_migrations` テーブルです。デプロイ時に一度実行してください（[マイグレーション](#マイグレーション)参照）。

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
```

プロセス停止時に配信中の行を取りこぼさないよう、graceful シャットダウンを配線してください（[graceful シャットダウン](#graceful-シャットダウン)を参照）。

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

> 実行可能なファイルが欲しい場合は [`examples/basic-pg`](./examples/basic-pg) を参照（使い捨て Postgres に対する migrate → enqueue → dispatch の一連の流れ）。

## ユースケース

- **顧客向け webhook（EC / SaaS）。** `order.created`・`payment.succeeded`・`subscription.updated` を、それを生んだ DB 書き込みと原子的に顧客のエンドポイントへ送信 — 幻の通知も消えた通知も起きません。
- **内部サービス間イベント。** Kafka / Redis / メッセージブローカーを立てず、既に動かしている Postgres だけで自社サービス間にドメインイベントを配信。
- **自前の「commit 後に送信」からの移行。** クラッシュでイベントを取りこぼしたり、rollback 後に誤って再送したりする場当たり的な「commit 後 `fetch(...)`」コードから移行。
- **サーバーレス / cron 配信。** 常駐ワーカーを動かす代わりに、AWS Lambda やスケジュールタスクから `relay.dispatchOnce()` でキューをドレイン。

## 比較

外部 webhook を送る一般的な手段と CommitCourier の違い：

|                        | DB トランザクション相乗り |     HTTP webhook 配信      |         署名         | 追加インフラ             |
| ---------------------- | :-----------------------: | :------------------------: | :------------------: | ------------------------ |
| **CommitCourier**      |            ✅             |             ✅             | ✅ Standard Webhooks | 不要（既存 Postgres）    |
| Svix / Outpost（SaaS） |            ❌             |             ✅             |          ✅          | ホスト型 SaaS / サーバー |
| BullMQ などのキュー    |            ❌             |      自前（ハンドラ）      |         自前         | Redis                    |
| ブローカー Outbox 系   |            ✅             | ❌（メッセージブローカー） |          ❌          | メッセージブローカー     |

CommitCourier は両方を兼ねます：Outbox 行を**あなたのトランザクション内**で書き（dual-write 不整合が原理的に起きない）、かつ **webhook-grade の HTTP 配信**（署名・リトライ・DLQ・台帳・SSRF）まで運びます。SaaS や Redis 型はローカルトランザクションに入れず、ブローカー Outbox 系は相乗りできてもメッセージブローカーで止まります。

この領域の埋め込み型ライブラリは CommitCourier だけではありません — [Postel](https://postel.sh) も同様のトランザクショナル Outbox のアプローチを取り、一部の方向ではより広く展開しています（polyglot ロードマップ、SQLite、インバウンド webhook の*受信*）。CommitCourier の重点は Postgres での深さです：SSRF 防御、保管時 secret 暗号化、エンドポイント回路遮断、OpenTelemetry、LISTEN/NOTIFY 低遅延アクセラレータ、`pg` / Knex / Drizzle / Prisma アダプタ、`doctor` CLI、読み取り専用の DLQ 調査＋リプレイ API、`sink` トランスポートによる配信 SaaS への任意ハンドオフ。

## 特長

- **トランザクショナル `enqueue`** — 業務トランザクションに相乗りし、webhook が業務の書き込みと原子的に整合（fail-closed）。
- **Postgres だけ** — Redis も別ブローカーも別サーバーも不要。
- **Standard Webhooks 署名** — 受信側は既存の Standard Webhooks 検証ライブラリ、または同梱の依存ゼロ `verifySignature`（`commitcourier/core`）でそのまま検証可能。
- **指数バックオフ＋ジッターのリトライと DLQ**（試行上限超過分の退避）。
- **配信台帳** — 試行ごとのリクエストヘッダ・応答ステータス・本文スニペット・所要時間を記録（サポート・監査用）。
- **リプレイ** — ID 指定、またはフィルタ指定（例：特定時刻以降の `dead` 全件）で再 enqueue。安全上限を内蔵し、広いリプレイが無制限な大量再送に膨らみません。
- **キャンセル** — 未送信の行を送信前に止める（`relay.cancel(id)`）。送信済み／配信中の行は変更しません。
- **サーバーレス／cron 対応** — `relay.dispatchOnce()` がキューを 1 回ドレインして返すので、常駐プロセス無しに Lambda や cron tick から配信できます。
- **エンドポイント回路遮断** — 連続失敗が N 回に達した登録エンドポイントを任意で自動 disable し、恒久ダウン宛先が DLQ を埋め続けるのを防止。
- **組込みの保持/削除** — `relay.prune({ olderThan })` が古い終端行をバッチ削除（アクティブ行は対象外）。テーブルの無限肥大を防止。
- **SSRF 防御は既定 ON** — プライベート／ループバック／リンクローカル／クラウドメタデータに加え、その他の非パブリックなネットワーク宛先（shared/CGNAT・マルチキャスト・ブロードキャスト・予約/ドキュメント用レンジ）を、パース後の URL ホストと DNS 解決後の全 IP の両方に対して遮断し、検査済み IP を接続時にピン留めします。
- **複数インスタンスでの単一配信**を `FOR UPDATE SKIP LOCKED` で担保。可視性タイムアウト回収で at-least-once。
- **観測（observe）モード** — 実送信せずに「送るはずの内容」を記録し、安全に段階導入。
- **保管時暗号化（組込み）** — `cipher`（組込みの WebCrypto AES-256-GCM ヘルパ、または独自の KMS/Vault アダプタ）を渡すと、`secret_snapshot`／エンドポイント secret を DB 上で暗号文として保持。保管時暗号化は前提条件（これ／DB ディスク暗号化／カラム暗号化のいずれか）で、未対応のまま起動すると警告が出ます。

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

### リトライと失敗の分類

配信結果がどう扱われるかは、安定した契約の一部です：

| 試行の結果                                            | アクション                                                                         |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `2xx`                                                 | `delivered`（終端）。                                                               |
| `410 Gone`                                            | リトライ予算を**消費せず**即 `dead`。登録エンドポイントは併せて disable される。     |
| その他の `4xx` / `5xx`                                | `retry.maxAttempts` まで指数バックオフでリトライ、その後 `dead`（DLQ）。            |
| ネットワークエラー／接続リセット／TLS／タイムアウト   | 上と同様 — リトライ後に `dead`。                                                    |
| `SSRF_BLOCKED`（宛先が遮断 IP に解決）                | リトライ可能な失敗として毎試行で可視化。解消されなければ最終的に `dead`。           |
| 署名 secret の欠落/不正（HTTP 前の決定的失敗）        | 即 `dead`（問題はエンドポイントではなく行なので、エンドポイントは disable しない）。 |

サーバー送出の `Retry-After`（delta-seconds または HTTP-date）は、算出バックオフを上回る場合に尊重し、`retry.capMs` にクランプします（敵対的/バグのあるヘッダで行を無期限に滞留させないため）。解釈できない値は通常のバックオフにフォールバックします。成功とみなすのは `2xx` のみです。

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

**保管時の secret 暗号化（前提条件）**：署名 secret（`secret_snapshot`／エンドポイント `secret`）は機微情報のため、保管時暗号化は**前提条件**です。次の **いずれか 1 つ**を必ず使ってください：① DB のディスク/ボリューム暗号化、② カラム単位の暗号化、③ `createRelay({ store, cipher })` に `cipher` を渡してライブラリに暗号文で保持させる。③ は組込みの `createAesGcmCipher(key)`（WebCrypto AES-256-GCM。鍵は `generateSecretKey()` で生成可）、または KMS/Vault 上の独自 `SecretCipher` を使えます（鍵の保管・配布・ローテーションは利用者責務）。`cipher` 未指定だと secret は平文のまま保存され、`createRelay` が**起動時に警告**します。① または ② を使う場合は `createRelay({ store, unsafeAllowPlaintextSecrets: true })` で承認して警告を抑制できます。

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
// …またはフィルタ指定（例：特定エンドポイントの、特定時刻以降の dead 全件）。選択は安全のため上限でクランプされる：
const res = await relay.replay({
  filter: { status: "dead", endpointId, since: new Date(Date.now() - 86_400_000) },
});
// `res.capped === true` は上限で打ち切られた印（全件は再送されていない）。さらに replay するには
// フィルタを絞る（`endpointId` やより狭い `since`）か `filter.limit` を上げる。同一フィルタでループしては
// いけない：replay は元行を変更しない（dead は dead のまま）ので、同じ先頭行を再選択して重複再送になる。

// 登録済みエンドポイントを無効化。
await relay.endpoints.disable(endpointId);
```

### 配信フック

`createRelay({ hooks })` は `onDelivered` / `onRetry` / `onDead` を受け取ります。各フックには secret を含まない `DeliveryEvent`（id・イベント種別・試行番号・エンドポイント id・ホスト・ステータス・エラー・所要時間。payload も署名 secret も含まない）が渡されます。契約：

- **行の状態遷移が実際に commit された時だけ発火します。** 可視性タイムアウト回収で lease を失ったワーカーは、台帳の試行は記録しますがフックは**発火しません** — 行を所有するワーカーが発火させます。
- **at-least-once であり exactly-once ではありません。** リトライは `onRetry` を再度発火し、クラッシュ後の再配信は `onDelivered` を複数回発火し得ます。台帳（`relay.attempts`）ではなく、id ＋試行番号で識別する通知として扱ってください。
- **fail-open。** フックが throw しても捕捉・ログして握りつぶし、配信状態を巻き戻したり dispatcher を止めたりしません。フックは dispatch 経路上でインラインに実行されるため、軽量に保ち、重い処理は自前のキューへ退避してください。

### graceful シャットダウン

`dispatcher.stop()` は新しい tick を止め、アイドル待機を中断し、配信中をドレインし、accelerator を unsubscribe します。ただしプロセスシグナルへの配線（と、その後の DB プールのクローズ）は利用者の責務です。コンテナオーケストレータ配下でシャットダウンを取りこぼすと、プロセスは配信中に強制 kill されます。行自体は安全（可視性タイムアウトで回収）ですが、避けられたはずの再配信のコストを払うことになります。常駐ワーカーの典型例：

```ts
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return; // 2 度目の SIGTERM/SIGINT が drain と競合しないように
  shuttingDown = true;
  await dispatcher.stop(); // tick 停止 ＋ 配信中のドレイン
  await pool.end(); // 他に誰も query しなくなってから pg プールを閉じる
  process.exit(0);
}
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => void shutdown());
```

1 回実行のサーバーレス／cron モデルでは止めるループがありません。`await relay.dispatchOnce(...)` は claim した行を配信し終えてから解決するので、返ってきたら `await pool.end()` するだけです（下記参照）。

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

手放しでの回復が欲しい場合は `cooldownMs` を足すと、disable されたエンドポイントが管理者を待たずに自力で回復します：

```ts
const relay = await createRelay({
  store,
  circuitBreaker: { failureThreshold: 20, cooldownMs: 5 * 60_000 },
});
```

エンドポイントが `cooldownMs` 以上 disable され続けると、dispatcher は配信を 1 回だけ half-open 試行として通します。成功すれば再 active 化（＋ counter リセット）、失敗すれば cooldown を再武装し次の試行はさらに `cooldownMs` 待ちます。cooldown 内は HTTP 試行を一切行いません。breaker でも `410 Gone` でも disable された任意の登録エンドポイントに適用され、`cooldownMs: 0`（既定）は手動回復のままにします。

### ロギングと可観測性

dispatch 経路は **fail-open** です。配信・claim・reclaim の失敗は throw されず、**logger** に送られます。その logger は**既定で no-op** です。logger を注入しないと通常の配信障害は無音になるため、未設定のときは `createRelay` が起動時に 1 回だけ警告を出します。ただし 2 つの重大カテゴリ — **セキュリティ事象**（SSRF ブロック）と**データ損失**（メッセージが DLQ 入り）— だけは別格で、logger 未設定でも `console.warn`／`console.error` にフォールバック出力し（その旨も併記）、設定漏れでも無音になりません。とはいえ本番ではすべてを捕捉するため必ず logger を注入してください。同梱の `createConsoleLogger()` が安全なコピペ既定です：

```ts
import { createRelay, createConsoleLogger } from "commitcourier";

const relay = await createRelay({ store, logger: createConsoleLogger() });
```

`Logger` インターフェースを満たす任意のオブジェクトでも構いません（例：pino/winston への橋渡し）：

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

任意の `commitcourier/otel` アダプタが、配信を OpenTelemetry の span とメトリクスに対応づけます。`@opentelemetry/api` を optional peer dependency として参照するため、メインエントリが OTel を巻き込むことはありません。結果を `createRelay` に渡します。

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

既定の Dispatcher はポーリングするため、静かなキューに enqueue された行は配信開始まで最大 `pollIntervalMs` 待ちます。任意の**アクセラレータ**はこの待機を短絡し、enqueue ごとに購読中の Dispatcher を起こして near-immediate に配信を始めます。Outbox 行は引き続き唯一の真実の源泉で、通知喪失時も配信が遅れるだけ（ポーラーが回収）なので、正当性・可用性には一切影響しません。

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

読み取り専用の `relay.list({ filter })` API で、リプレイ前に dead 行を調査できます。単調増加の `seq` による新しい順・キーセットページングで、secret を含まない行を返します。選んだ行を `replay({ filter })` で**再 enqueue**（書き込み）します。

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

これは [Standard Webhooks](https://www.standardwebhooks.com/) の慣例なので、受信側は互換の検証ライブラリでそのまま検証できます。CommitCourier は独自署名方式を作りません。利便のため、純粋・依存ゼロの `verifySignature` ヘルパを `commitcourier/core` に同梱しています（内部サービス間 webhook や統合テストに便利で、検証用の別依存を追加せずに済みます）：

```ts
import { verifySignature } from "commitcourier/core";

// `rawBody` は JSON.parse 前の生のリクエスト body 文字列。
const ok = await verifySignature({
  id: req.headers["webhook-id"],
  timestamp: req.headers["webhook-timestamp"],
  payload: rawBody,
  header: req.headers["webhook-signature"],
  secrets: [endpointSecret], // ローテーション期間中は両方の鍵を渡す
});
if (!ok) return res.status(400).end(); // タイムスタンプ期限切れ・署名不正・不一致
```

タイムスタンプの期限切れ（既定許容 300 秒、`toleranceSec` で上書き可）、欠落／壊れた署名、不一致のいずれでも `false` を返します（throw しません）。`secrets` を複数渡せばローテーションをまたいでどちらの鍵でも検証できます。

> **body の正規化。** `payload` は Postgres `jsonb` で保存されるため、配信 body は enqueue した値の JSON ラウンドトリップになります（オブジェクトのキー順は非保持、重複キーは畳み込み、意味のない空白は除去）。署名は常に「実際に送るバイト列」に対して計算されるので、これが原因で検証が失敗することはありません。ただし配信バイト列が入力と完全一致する保証はありません。バイト厳密が必要なら payload を事前シリアライズ済みの文字列として enqueue してください。

## 保証と非目標

**保証すること**

- dual-write による幻の／消えた webhook が起きない — Outbox 行が業務トランザクションと原子的。
- プロセスクラッシュでイベントを失わない — 可視性タイムアウト回収による at-least-once。
- 複数インスタンスで同じ行を同時に二重クレームしない — `FOR UPDATE SKIP LOCKED` が 2 つの dispatcher による同一行の同時取得を防ぎます。ただし配信は依然 **at-least-once** であり exactly-once ではありません：HTTP 送信成功後・状態 commit 前にクラッシュすると、可視性タイムアウト回収で再配信されます（非目標を参照）。
- 改ざん・なりすましの検出 — Standard Webhooks 署名。
- outbound SSRF：一般的なプライベート／ループバック／リンクローカル／メタデータ、その他の非パブリック宛先を既定で遮断（ベストエフォートであり絶対的な保証ではありません — [セキュリティポリシー](./SECURITY.ja.md)参照）。

**非目標（正直に明記）**

- 受信側での **exactly-once な「効果」**。提供するのは at-least-once ＋ idempotency key であり、最終的な重複排除は受信側の責務です。
- エンドポイント横断の**全順序保証**。既定は順不同です（エンドポイント単位 FIFO はオプトインで提供：`createDispatcher({ ordering: "per-endpoint" })`）。
- **無限スケール**。既存 Postgres 上の中〜中規模を正直な対象とし、billions/sec 級は対象外です。
- **暗号鍵の管理**。署名 secret の保管時暗号化は満たすべき前提条件です（DB ディスク暗号化／カラム暗号化／`cipher` のいずれか。「設定」参照）。`cipher` を使う場合、鍵自体の保管・配布・ローテーションは利用者の責務です。`cipher` 未設定時は `createRelay` が起動時に警告し、保管時暗号化は DB 側の責務になります（`unsafeAllowPlaintextSecrets: true` で承認）。
- インバウンド webhook の*受信*（HTTP サーバ／フレームワーク統合）、および顧客向け管理ポータル UI。受信側の `verifySignature` ヘルパは*提供します*（[署名の検証](#署名の検証受信側)参照）が、エンドポイントの構築は利用者の責務です。

## マイグレーション

`store.migrate()` がスキーマを適用します。既存の DB に、**業務 3 テーブル＋マイグレーション追跡 1 テーブル（計 4 つ）**を作成します：

| テーブル                    | 用途                                                                        | 保持                                          |
| --------------------------- | --------------------------------------------------------------------------- | --------------------------------------------- |
| `webhook_outbox`            | キュー兼・真実の源泉。enqueue したイベント 1 件につき 1 行。                 | 終端行は `relay.prune` で削除。               |
| `webhook_delivery_attempts` | 追記専用の配信台帳。試行 1 回につき 1 行（outbox からカスケード）。          | outbox 行と一緒に削除（`ON DELETE CASCADE`）。 |
| `webhook_endpoints`         | 任意の登録エンドポイントレジストリ（登録エンドポイント運用のみ）。           | 長期保持の設定。prune 対象外。                |
| `commitcourier_migrations`  | 適用済みマイグレーションの追跡。利用者データではない。prune しない。         | 恒久。                                        |

方針：

- **Forward-only。** マイグレーションは順番に適用され、**冪等**です（`migrate()` の再実行は安全で、適用済みなら no-op。各スクリプトを `commitcourier_migrations` に記録し、未適用分のみ実行）。down/ロールバックスクリプトはありません。前進あるのみです。
- **並行安全。** `migrate()` は Postgres のトランザクションスコープの advisory lock（`pg_advisory_xact_lock`）を取得するため、デプロイ時に複数インスタンスから実行しても競合せず直列化されます。
- **Expand-and-contract。** スキーマ変更は既存列の即時 drop / rename を避けるため、ローリングデプロイ中に旧アプリと新スキーマが共存できます。
- **実行タイミング。** デプロイ時に一度だけ実行（リリース/CI のステップ、または dispatcher 起動前のアプリ起動時）— リクエストごとには実行しません。`commitcourier doctor` が未適用のマイグレーションを報告します。

## CommitCourier の取り外し

CommitCourier は非侵襲かつ可逆です。すべては上記 4 つの専用テーブル（`webhook_outbox` / `webhook_delivery_attempts` / `webhook_endpoints` / `commitcourier_migrations`）に隔離されています。dispatcher を止め、`enqueue` 呼び出しを外し、これらのテーブルを drop すれば、業務スキーマには一切手を加えずに撤去できます。

## 公開 API

| import                                        | エクスポート                                                                                                                                                                                                                       |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commitcourier`                               | `createRelay`、`createConsoleLogger`、`Relay`/`RelayInit` 型、`Store` ポート、全ドメイン型。                                                                                                                                       |
| `commitcourier/core`                          | 純粋・依存ゼロのドメイン層（`sign`、`verifySignature`、`createConsoleLogger`、`backoffMs`、状態遷移、SSRF ヘルパ、`resolveConfig`、`RelayError`、型）。import してもドライバや `node:*` 組込みを一切引き込まない。                 |
| `commitcourier/store/pg`                      | `postgresStore({ pool })` — `Store<PoolClient>`。                                                                                                                                                                                  |
| `commitcourier/store/knex`                    | `knexStore({ knex })` — `Store<Knex.Transaction>`。                                                                                                                                                                                |
| `commitcourier/store/drizzle`                 | `drizzleStore({ db })` — `Store<DrizzleTx>`（node-postgres 上の Drizzle）。                                                                                                                                                        |
| `commitcourier/store/prisma`                  | `prismaStore({ prisma })` — `Store<PrismaTx>`（Prisma の interactive transaction）。                                                                                                                                               |
| `commitcourier/otel`                          | `createOtelInstrumentation({ tracer, meter })` — 任意の OpenTelemetry 計装。`createRelay({ instrument, hooks })` に渡す。                                                                                                          |
| `commitcourier/accelerator/pg`                | `createPgAccelerator({ pool, listen })` — Postgres LISTEN/NOTIFY による任意の低遅延 wake。`createRelay({ accelerator })` に渡す。                                                                                                  |
| `commitcourier/forward` _(experimental)_      | `sink` トランスポート用の `Sink` ポートと `SinkEvent` / `SinkResult` 型 — [実験的：webhook 配信 SaaS へのハンドオフ](#実験的webhook-配信-saas-へのハンドオフsink-トランスポート) を参照。**マイナーリリースで API 変更の可能性。** |
| `commitcourier/forward/svix` _(experimental)_ | `svixSink(...)` — Svix 用の公式サンプル `Sink` アダプタ（`svix` は optional peer）。**マイナーリリースで API 変更の可能性。**                                                                                                      |

主要シグネチャ：

```ts
function createRelay<TTx>(init: RelayInit<TTx>): Promise<Relay<TTx>>;

interface Relay<TTx> {
  enqueue(trx: TTx, input: EnqueueInput): Promise<{ id: string }>;
  enqueueMany(trx: TTx, inputs: EnqueueInput[]): Promise<{ ids: string[] }>;
  enqueueUnsafe(input: EnqueueInput): Promise<{ id: string }>;
  createDispatcher(options?: DispatcherOptions): Dispatcher;
  dispatchOnce(
    options?: DispatcherOptions,
    runOptions?: RunOnceOptions,
  ): Promise<{ processed: number }>;
  attempts(opts: { outboxId: string }): Promise<DeliveryAttempt[]>;
  replay(
    opts: { outboxId: string } | { filter: ReplayFilter },
  ): Promise<{ ids: string[]; capped: boolean }>;
  cancel(outboxId: string): Promise<{ cancelled: boolean }>;
  get(outboxId: string): Promise<OutboxListItem | null>;
  list(filter?: OutboxListFilter): Promise<Page<OutboxListItem>>;
  prune(opts: PruneOptions): Promise<{ deleted: number }>; // 保持：古い終端行を削除
  stats(): Promise<OutboxStats>;
  endpoints: EndpointAdmin; // register / update / enable / disable / get / list
}
```

### 実験的：webhook 配信 SaaS へのハンドオフ（`sink` トランスポート）

> ⚠️ **実験的（experimental）。** この面は export されていますが、まだ安定性保証の対象外で、マイナーリリースで変更される可能性があります。

CommitCourier 自身が HTTP 配信する代わりに、各イベントを外部の webhook 配信 SaaS（Svix・Outpost・Hookdeck など）へ引き渡せます。このとき **原子的・at-least-once な enqueue は引き続きあなたのトランザクションに相乗り** します。配信トランスポートを `sink` にして `Sink` を渡します：

```ts
import { Svix } from "svix";
import { createRelay } from "commitcourier";
import { svixSink } from "commitcourier/forward/svix"; // または独自の Sink

const relay = await createRelay({
  store,
  delivery: { transport: "sink" },
  sink: svixSink({ svix: new Svix(process.env.SVIX_TOKEN!), appId: "app_..." }),
});
```

`sink` モードでは署名 / SSRF / 回路遮断は SaaS 側に委譲されます。`Sink` ポート（`commitcourier/forward`）を自分で実装すれば任意のプロバイダに対応できます。

## 機能の安定度

CommitCourier は 1.0 前（`0.x`）です。`0.x` の間は **minor** リリースでも破壊的変更が入り得ます。下表は各サーフェスの期待値を示します（完全な方針は[互換性とサポート](#互換性とサポート)を参照）。出荷済み機能の全一覧は[特長](#特長)と [CHANGELOG](./CHANGELOG.ja.md) にあります。

| 安定度                                           | サーフェス                                                                                                                                                  |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stable**                                       | トランザクショナル `enqueue`、HTTP dispatcher、`pg` / Knex / Drizzle / Prisma ストア、リトライ／バックオフ／ジッター、配信台帳、DLQ、Standard Webhooks 署名、SSRF 防御、保管時 secret 暗号化。 |
| **Beta** — minor で変更あり得る                  | 登録エンドポイント管理 API、回路遮断、登録エンドポイントキャッシュ、OpenTelemetry アダプタ、LISTEN/NOTIFY アクセラレータ、リプレイ、保持/削除、`cancel`、`doctor` CLI。 |
| **Experimental** — minor で変更あり得る（任意のサブパス） | 汎用 `sink` トランスポート（`commitcourier/forward`）と Svix サンプルアダプタ（`commitcourier/forward/svix`）。                                              |

## 互換性とサポート

| 依存            | 対象                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| **Node.js**     | 22.19.0 以上。                                                                                          |
| **PostgreSQL**  | 12 以上（最低ライン。CI の integration テストは PostgreSQL 16 で実行）。                                 |
| **アダプタ**    | `pg` / `knex` / `drizzle-orm` / `@prisma/client` は optional peer dependency — 使う 1 つだけをインストール。範囲は `peerDependencies` に宣言。 |

- **`0.x` の SemVer。** SemVer に従い、`0.x` の間は minor（`0.y`）リリースでも破壊的変更が入り得ます。上記 Stable サーフェスは CHANGELOG への記載とともに保守的に変更し、Beta / Experimental サーフェスは破壊的変更が最も起こりやすい領域です。
- **破壊的変更**は [CHANGELOG](./CHANGELOG.ja.md) に明記します。`1.0` で安定化したのち、公開 API は通常どおり SemVer に従います。
- **セキュリティ修正**とサポート対象バージョン・非公開報告の方針は[セキュリティポリシー](./SECURITY.ja.md)を参照してください。

## ロードマップ

- **1.0 に向けて：** Beta サーフェスの安定化と、`sink` トランスポートを experimental から昇格させるか（安定 API の確約）薄いハンドオフのまま留めるかの判断。
- **既存シーム上：** BullMQ アクセラレータとさらなるエンドポイント管理 API。いずれも既設の `Accelerator` / 管理シーム上に構築。

## セキュリティ

脆弱性を見つけた場合は、**公開 Issue を作成せず**、**[セキュリティポリシー](./SECURITY.ja.md)**に従って非公開で報告してください。同ドキュメントはセキュリティモデル（SSRF の既定、署名、secret の取り扱い）と、対象／対象外の範囲も説明しています。

## ライセンス

[MIT](./LICENSE)
