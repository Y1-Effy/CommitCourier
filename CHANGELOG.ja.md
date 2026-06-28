# 変更履歴（Changelog）

🇬🇧 English: **[CHANGELOG.md](./CHANGELOG.md)**（こちらがメインです）

本プロジェクトの注目すべき変更点をここに記録します。

形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に基づき、本プロジェクトは
[セマンティック バージョニング](https://semver.org/lang/ja/) に従います。

## [Unreleased]

## [0.3.0] - 2026-06-28

### Added（追加）

- **enqueue payload の検証**：`enqueue` / `enqueueMany` / `enqueueUnsafe` は、`jsonb` として保存できない
  payload（循環参照・`BigInt`・`undefined` にシリアライズされる値）を、生のドライバエラーを業務トランザクション
  に漏らす代わりに安定コード `RelayError("ENQUEUE_INVALID_PAYLOAD")` で拒否するようになりました（エンドポイント
  欠落時の `ENQUEUE_NO_TARGET` と対称）。任意の `createRelay({ maxPayloadBytes })`（既定オフ）でシリアライズ後の
  UTF-8 バイト長の上限も設定できます。純粋ヘルパ `validatePayload` として `commitcourier/core` から公開。

### Changed（変更）

- **`Store` を capability ロールに分解（追加的・非破壊）**。約 25 メソッドを単一に集約していた
  `Store<TTx>` ポートを、責務ごとの 7 つのロールインターフェース——`OutboxEnqueueStore<TTx>` /
  `DispatchStore` / `EndpointStore` / `OutboxQueryStore` / `ReplayStore` / `MaintenanceStore` /
  `SchemaStore`——の合成として再定義しました（各ロールが自身の atomicity・トランザクション契約を
  明記）。`Store` は従来どおりこれら全ロールを extends するため、同梱の `pg` / Knex / Drizzle /
  Prisma アダプタや既存の `Store` 実装は無変更です。内部では各 consumer が使用するロールのみに依存
  するようになり（例：dispatcher は `DispatchStore`）、各ロールは `commitcourier` から export して
  いるため、第三者アダプタ作者がどのメソッドがどの責務に属するかを把握できます。
- **4 つのリレーショナルアダプタの重複をすべて共有 SQL ストアへ集約（内部のみ・振る舞い不変）**。
  `pg` / Drizzle / Prisma / Knex の各アダプタは、同じ Postgres SQL を約 300 行ずつ重複実装して
  いました。このロジックを、薄いアダプタ別 `SqlExecutor` シーム（query / execute / insert-on-tx /
  withTx）の上の内部 `createSqlStore` に一元化し、Store メソッド追加が 4 箇所から 1 箇所で済むように
  しました。Knex は `$n` ではなく positional `?` を束縛するため、共有の numbered SQL を小さな
  `numberedToQmark` ヘルパで `knex.raw` 直前に変換します（クエリビルダ実装は廃止）。4 アダプタ合計で
  約 1310 → 約 360 行に削減。SQL は実質不変で、integration / concurrency / fault スイートが
  Postgres 12/16/17 で全通過します。あわせて共有 `_shared.ts` を責務別に
  `store/sql/{constants,migrations,row-mappers,columns,query-builders,placeholders}.ts` へ分割しました
  （`_shared.ts` から再 export するため import は不変）。公開 API の変更はありません。

### Documentation（ドキュメント）

- Quick start で最初から `createConsoleLogger()` を注入するようにしました。既定の no-op logger が通常の
  配信失敗・リトライを黙って握り潰さないようにするためです。
- マイグレーション：既に巨大な `webhook_outbox` へのインデックス構築が書き込みロックを取る点（`migrate()` は
  `CONCURRENTLY` ではなく通常の `CREATE INDEX` を使う）と、大規模既存 DB 向けの指針を明記。
- アクセラレータ：常駐 Dispatcher 多数時のアイドルポーリング負荷と、長めの `pollIntervalMs` との併用方針を明記。

## [0.2.0] - 2026-06-28

npm への初の公開リリース。（下記の未公開 0.1.0 開発ベースラインを置き換えます。）

### Added（追加）

- **`sink` トランスポートによる SaaS ハンドオフ（experimental）**：`createRelay({ delivery: { transport: "sink" }, sink })`
  は、HTTP で直接配信する代わりに各イベントを `Sink`（Svix などの webhook 配信 SaaS）へ at-least-once で引き渡します。
  at-least-once の引き渡し自体はあなたのトランザクションに相乗りしつつ、最終配信・署名は SaaS に委譲します。`Sink`
  ポートと型は `commitcourier/forward` から、公式の Svix サンプルアダプタは `commitcourier/forward/svix` から提供
  （`svix` は optional peer）。**experimental：この API はマイナーリリースで変更される可能性があります。**
- **受信側 `verifySignature`（DX）**：インバウンドの Standard Webhooks リクエストを検証する、純粋・依存ゼロの
  ヘルパを `commitcourier/core` に追加（`sign` の対）。`{id}.{timestamp}.{payload}` に対する `v1,<base64>` HMAC を
  再計算し、`webhook-signature` の各トークンと定数時間比較します。`secrets` を複数受け付け（ローテーションをまたいで
  どちらの鍵でも検証可）、タイムスタンプを許容差（既定 `300` 秒）で検証します。期限切れ・壊れた署名・不一致では
  `false` を返し（throw しない）ので、`true` 以外はすべて reject 扱いにできます。内部 webhook のために別途検証用の
  依存を追加する必要がなくなります。
- **`createConsoleLogger()`（DX）**：すぐ使える `Logger`（`commitcourier` と `commitcourier/core` から export）。
  これでリレーが無音ではなく一行で可観測になります。あわせて `createRelay` は `logger` 未設定時に起動時 1 回だけ
  警告を出すようにしました。fail-open な dispatch 経路は、未設定だと配信失敗・DLQ 遷移・SSRF ブロックをすべて
  握り潰すためです。
- **回路遮断の自動復旧（half-open）**：`createRelay({ circuitBreaker: { cooldownMs: N } })`（既定 `0` = 無効）で、
  disable されたエンドポイントが自力で回復できるようになります。`disabled_at` から `cooldownMs` 以上が経過すると、
  dispatcher は配信を 1 回だけ試行（half-open）として通します。成功するとエンドポイントを再 active 化し失敗
  カウンタをリセット、失敗すると cooldown を再武装して次の試行はさらに `cooldownMs` 待ちます。breaker でも `410`
  でも disable された任意の登録エンドポイントに適用され、cooldown 内は HTTP 試行を一切行いません。4 アダプタ
  すべてに `Store.reactivateEndpoint` として実装。
- **Cancel API**：`relay.cancel(outboxId)` が未送信の行を取り消します。`pending → cancelled` へは
  `pending` のときのみ遷移し、既にクレーム済み（`in_flight`）や終端状態の行は変更しません。`{ cancelled }` を
  返すので「間に合った」か「既に送信済み／不明な id」かを呼び出し側で判別できます。4 アダプタすべてに実装し、
  不正な id は事前検証で `INVALID_ARGUMENT` になります。
- **Auto-disable 回路遮断**：`createRelay({ circuitBreaker: { failureThreshold: N } })`（既定 `0` =
  無効）で、登録エンドポイントへの連続配信失敗が `N` 回に達すると自動で disable し、成功で counter をリセット
  します。インクリメントと disable は、これまで未使用だった `consecutive_failures` 列に対する単一の原子的
  UPDATE です。fail-open（counter 更新失敗が配信を止めない）で、影響は登録エンドポイント経路のみ。`410 Gone`
  経路は従来どおり直接 disable します。
- **サーバーレス／cron 向け 1 回実行**：`dispatcher.runOnce({ reclaim, maxRows })` と糖衣の
  `relay.dispatchOnce(options, runOptions)` が、常駐ループ無しでキューを 1 回ドレインして返します
  （`concurrency`/`batchSize`/`ordering` を尊重）。返り値は `{ processed }`。連続ループ稼働中は拒否します。
  常駐 Dispatcher を持てない Lambda/cron に好適。
- **運用フットガン対策**：`relay.get(outboxId)` が単一の outbox 行を取得（読み取り専用・secret 非露出）。
  `relay.replay(...)` は選択件数を安全上限にクランプし `{ ids, capped }` を返すため、広い `{ status: "dead" }`
  の replay が無制限な大量再送に膨らむことはありません（`capped` が true の間はページングして継続）。
- **組込みの保持/削除**：`relay.prune({ olderThan, statuses?, limit? })` が、しきい日時より古い終端行を
  古い順にバッチ削除し（配信台帳は CASCADE）、`{ deleted }` を返します。対象は非アクティブ状態のみ（既定
  `delivered`/`dead`/`cancelled`）で、`pending`/`in_flight` を渡すと `INVALID_ARGUMENT`＝稼働中の行は決して
  削除されません。4 アダプタすべてに実装。1 回の呼び出しは上限（既定 10,000・最大 100,000）でクランプされ、
  無制限な削除やテーブル全体ロックを起こしません。
- **`commitcourier doctor` CLI**：ローカル開発と CI 向けの bin。DB スキーマ・適用済み/未適用マイグレーション・
  配信インデックス・キュー健全性・設定（既定 vs 上書き、推奨だが未設定のチェックリストと理由、リスク警告）の
  レディネスを点検します。`--config <file>`／`--skip-db`／`--database-url`／`--json` に対応し、コアテーブル欠落や
  設定不正で非ゼロ終了（デプロイのゲートに使用可）。`pg` は DB 検査時のみ必要です。
- **低遅延 配信アクセラレータ**：optional・fail-open な wake シーム。`createRelay({ accelerator })`
  が enqueue ごとにアクセラレータへ signal し、生成する各 Dispatcher を購読させるため、enqueue 直後の行が
  ポーリング間隔を待たず near-immediate に配信されます。第一実装の `commitcourier/accelerator/pg` の
  `createPgAccelerator` は Postgres LISTEN/NOTIFY を使用：`NOTIFY` は enqueue トランザクションに相乗りし
  （COMMIT 時に配送＝行可視化より前に届かない）、専用かつ自己修復する LISTEN 接続が Dispatcher のアイドル
  バックオフを短絡します。Outbox 行は引き続き唯一の真実の源泉で、通知喪失時も配信は遅れるだけで失われません
  （ポーラーが回収）。汎用 `Accelerator` シームは依存ゼロで、BullMQ アクセラレータは同シーム上の将来アダプタ。
- **スキーマバージョン管理テーブル**：`migrate()` が適用済みマイグレーションを `commitcourier_migrations`
  テーブルに記録し、未適用分のみを順に適用します（従来どおり冪等で、テーブル導入前のデプロイにも安全）。
  4 アダプタ共通で単一ファイル適用を置き換え、増分的な `00N_*` スキーマ変更の土台を整えます。
- **読み取り専用 DLQ／outbox 一覧 API**：`relay.list({ status, since, endpointId, limit, cursor })`
  が outbox 行を単調増加 `seq` の新しい順でページングします（DLQ 調査・監視向け）。行は secret 非露出
  （署名鍵スナップショットは選択しない）、ページングは seq キーセット（`nextCursor`）。
- **エンドポイント一覧**：`endpoints.list({ status, limit, cursor })` が secret 非露出の
  サマリ（`secret`/`secret_secondary` を含まない）を id キーセットで返します。どちらの一覧メソッドも
  4 アダプタ（`pg`/`knex`/`drizzle`/`prisma`）すべてに実装。一覧フィルタは事前検証され、不正な
  `cursor`/`status` は生の Postgres キャストエラーではなく新しい `INVALID_ARGUMENT` `RelayError` になります。
- **OpenTelemetry アダプタ**：`commitcourier/otel` が `createOtelInstrumentation({ tracer, meter })`
  を公開し、`createRelay` に渡す `{ instrument, hooks }` を返します。各配信試行は secret 非露出属性を持つ
  CLIENT span を 1 本発行し、結果で `commitcourier.deliveries` カウンター（`outcome = delivered | retry | dead`）と
  `commitcourier.delivery.duration` ヒストグラムを更新します。`@opentelemetry/api` は optional peer。シーム本体
  （`RelayInit.instrument` ＋ `endpointId`/`host` を持つ secret 非露出の `DeliveryStart`/`DeliveryEvent`）は
  依存ゼロ・fail-open です。
- **鍵ローテーション／二重署名**：ローテーション中は登録エンドポイントへの配信を現行鍵と
  旧鍵の両方で署名します（Standard Webhooks のスペース区切り `v1,…` 複数署名）。受信側はどちらの鍵
  でも検証可能。管理操作 `endpoints.rotateSecret(id, newSecret)` と `endpoints.finalizeRotation(id)`
  を追加（冪等マイグレーションで `secret_secondary` 列を追加。`cipher` 設定時は保管時暗号化）。
- **`Retry-After` 尊重**：リトライ対象応答が `Retry-After`（delta-seconds または HTTP-date）
  を持つ場合、次回試行を `max(backoff, Retry-After)` に設定し、`retry.capMs` で上限クランプします。
- **`410 Gone` 即時無効化**：`410` 応答はリトライ枠を消費せず行を即 `dead` にし、登録
  エンドポイントを無効化します。
- **オプトインのエンドポイント単位 FIFO**：`createDispatcher({ ordering: "per-endpoint" })`
  で各登録エンドポイントの行を到着順に逐次配信します（エンドポイントごとに in-flight は 1 本）。
  既定（`"none"`）は従来どおり順不同・並列。インライン宛先は対象外。順序付けは単調増加の挿入列
  （`webhook_outbox.seq`）で行うため、同一トランザクションでまとめて enqueue したイベントも挿入順に
  配信されます。
- **Drizzle アダプタ**：`commitcourier/store/drizzle` から `drizzleStore` を公開。pg/knex と
  同一の Postgres dialect・契約を再利用。`drizzle-orm` は任意 peer 依存。
- **Prisma アダプタ**：`commitcourier/store/prisma` から `prismaStore` を公開。raw SQL ベース
  （同一 dialect・契約を再利用）で、enqueue は呼び出し元の `prisma.$transaction` に相乗り。`@prisma/client`
  は任意 peer 依存で、構造的型で受けるため未インストールでもライブラリはビルド可能。
- 署名 secret の任意の保管時暗号化：`createAesGcmCipher`（WebCrypto AES-256-GCM）、`SecretCipher`
  インターフェース、`generateSecretKey` を追加し、`createRelay({ cipher })` で配線。secret は
  バージョン付き `ccsec.v1.` 暗号文エンベロープで保存され、署名直前にメモリ上でのみ復号されます。
- `RelayInit.endpointCacheTtlMs` による任意の in-process 登録エンドポイントキャッシュ。登録
  エンドポイント運用のホットパスで配信ごとの `findEndpoint` 往復を削減します。
- 配信クライアントの undici 接続再利用を調整する `delivery.keepAliveTimeoutMs`（既定 10s）と
  `delivery.connections`。

### Changed（変更）

- 署名で、import 済みの HMAC `CryptoKey` を secret ごとにメモ化（境界付き・プロセス内 LRU）するように変更。
  配信ごと（ローテーション中は鍵ごと）の `crypto.subtle.importKey` を削減し、高スループット時の CPU を低減します。
  署名出力は不変で、鍵は非抽出（extractable: false）のままです。
- claim と reclaim のクエリを `pending` / `in_flight` 行のみの部分インデックスに変更。delivered/dead
  行が増えても高速なまま保たれます。
- dispatcher のアイドル待機を約 50ms から `pollIntervalMs` までの適応バックオフに変更。アイドル後の
  初回配信のレイテンシを下げます。

### Fixed（修正）

- Windows Docker Desktop で integration テストがスキップされないように修正。`existsSync` で検出
  できない名前付きパイプに依存せず、Docker CLI へフォールバックして検出します。

## [0.1.0] - 2026-06-25

初期の開発ベースライン（npm には未公開）。

### Added（追加）

- 呼び出し側の DB トランザクションに相乗りするトランザクショナルな `enqueue`、Standard Webhooks
  署名・指数バックオフ＋ジッタ付きリトライ・DLQ・完全な配信台帳・SSRF 防御（既定で有効）・
  `FOR UPDATE SKIP LOCKED` による複数インスタンス間の単一配信を備えたバックグラウンド
  dispatcher、`pg` ＋ Knex のストアアダプタ。
- 公開 `RelayErrorCode` union の `MISSING_SECRET`。secret スナップショットを持たない inline 宛先用。
- パッケージ entry point から `Dispatcher` / `DispatcherOptions` を公開（dispatcher を型注釈可能に）。
- `postgresStore` / `knexStore` ファクトリに、トランザクション束縛を説明する TSDoc を追加。

### Fixed（修正）

- `pg` アダプタで、`COMMIT` 失敗後の `ROLLBACK` が元のエラーを覆い隠さないようにしました。

> ⚠️ `1.0.0` 以前: API およびパッケージ名は今後変更される可能性があります。

[Unreleased]: https://github.com/Y1-Effy/CommitCourier/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/Y1-Effy/CommitCourier/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Y1-Effy/CommitCourier/releases/tag/v0.2.0
