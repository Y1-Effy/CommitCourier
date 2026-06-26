# 変更履歴（Changelog）

🇬🇧 English: **[CHANGELOG.md](./CHANGELOG.md)**（こちらがメインです）

本プロジェクトの注目すべき変更点をここに記録します。

形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に基づき、本プロジェクトは
[セマンティック バージョニング](https://semver.org/lang/ja/) に従います。

## [Unreleased]

### Added（追加）

- **鍵ローテーション／二重署名（v1.1）**：ローテーション中は登録エンドポイントへの配信を現行鍵と
  旧鍵の両方で署名します（Standard Webhooks のスペース区切り `v1,…` 複数署名）。受信側はどちらの鍵
  でも検証可能。管理操作 `endpoints.rotateSecret(id, newSecret)` と `endpoints.finalizeRotation(id)`
  を追加（冪等マイグレーションで `secret_secondary` 列を追加。`cipher` 設定時は保管時暗号化）。
- **`Retry-After` 尊重（v1.1）**：リトライ対象応答が `Retry-After`（delta-seconds または HTTP-date）
  を持つ場合、次回試行を `max(backoff, Retry-After)` に設定し、`retry.capMs` で上限クランプします。
- **`410 Gone` 即時無効化（v1.1）**：`410` 応答はリトライ枠を消費せず行を即 `dead` にし、登録
  エンドポイントを無効化します。
- **オプトインのエンドポイント単位 FIFO（v1.1）**：`createDispatcher({ ordering: "per-endpoint" })`
  で各登録エンドポイントの行を到着順に逐次配信します（エンドポイントごとに in-flight は 1 本）。
  既定（`"none"`）は従来どおり順不同・並列。インライン宛先は対象外。順序付けは単調増加の挿入列
  （`webhook_outbox.seq`）で行うため、同一トランザクションでまとめて enqueue したイベントも挿入順に
  配信されます。
- **Drizzle アダプタ（v1.1）**：`commitcourier/store/drizzle` から `drizzleStore` を公開。pg/knex と
  同一の Postgres dialect・契約を再利用。`drizzle-orm` は任意 peer 依存。
- **Prisma アダプタ（v1.1）**：`commitcourier/store/prisma` から `prismaStore` を公開。raw SQL ベース
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

- claim と reclaim のクエリを `pending` / `in_flight` 行のみの部分インデックスに変更。delivered/dead
  行が増えても高速なまま保たれます。
- dispatcher のアイドル待機を約 50ms から `pollIntervalMs` までの適応バックオフに変更。アイドル後の
  初回配信のレイテンシを下げます。

### Fixed（修正）

- Windows Docker Desktop で integration テストがスキップされないように修正。`existsSync` で検出
  できない名前付きパイプに依存せず、Docker CLI へフォールバックして検出します。

## [0.1.0] - 2026-06-25

最初の公開リリース。

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

[Unreleased]: https://github.com/Y1-Effy/CommitCourier/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Y1-Effy/CommitCourier/releases/tag/v0.1.0
