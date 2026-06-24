# 変更履歴（Changelog）

🇬🇧 English: **[CHANGELOG.md](./CHANGELOG.md)**（こちらがメインです）

本プロジェクトの注目すべき変更点をここに記録します。

形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に基づき、本プロジェクトは
[セマンティック バージョニング](https://semver.org/lang/ja/) に従います。

## [Unreleased]

### Added（追加）

- 公開 `RelayErrorCode` union に `MISSING_SECRET` を追加。secret スナップショットを持たない inline
  宛先を、文書化済みで機械可読なコードで報告するようにしました。
- `postgresStore` / `knexStore` ファクトリに、トランザクション束縛を説明する TSDoc を追加。

### Changed（変更）

- 内部: 配信経路のエラー要約を `src/delivery/_error.ts`（`errorCode` / `secretFreeSummary`）に
  統一し、secret を含めない保証を1箇所に集約しました。

### Fixed（修正）

- `pg` アダプタで、`COMMIT` 失敗後の `ROLLBACK` が元のエラーを覆い隠さないようにしました。

## [0.0.0] - 2026-06-25

プレリリース。最初の公開表面: トランザクショナルな `enqueue`、Standard Webhooks 署名・リトライ・
DLQ・配信台帳・SSRF 防御を備えたバックグラウンド dispatcher、`FOR UPDATE SKIP LOCKED` による単一
配信、`pg` ＋ Knex のストアアダプタ。

> ⚠️ `1.0.0` 以前: API およびパッケージ名は今後変更される可能性があります。

[Unreleased]: https://github.com/Y1-Effy/CommitCourier/compare/v0.0.0...HEAD
[0.0.0]: https://github.com/Y1-Effy/CommitCourier/releases/tag/v0.0.0
