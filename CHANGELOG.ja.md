# 変更履歴（Changelog）

🇬🇧 English: **[CHANGELOG.md](./CHANGELOG.md)**（こちらがメインです）

本プロジェクトの注目すべき変更点をここに記録します。

形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に基づき、本プロジェクトは
[セマンティック バージョニング](https://semver.org/lang/ja/) に従います。

## [Unreleased]

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
