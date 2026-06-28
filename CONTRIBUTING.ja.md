# CommitCourier への貢献

🇬🇧 English: **[CONTRIBUTING.md](./CONTRIBUTING.md)**（こちらがメインです）

CommitCourier の改善にご興味をお持ちいただきありがとうございます。本書はプロジェクトのセット
アップ方法、従うべき規約、変更を取り込んでもらうまでの流れを説明します。

## 前提

- Node.js **22.19.0 以上**
- npm（リポジトリには `package-lock.json` を同梱）
- Docker — integration / concurrency / fault / perf スイートの実行時のみ必要
  （`testcontainers` が実際の PostgreSQL を起動）。ユニットテストに Docker は不要。

## はじめに

```bash
npm ci
npm run check   # typecheck + lint + lint:lang + unit tests
```

## よく使うスクリプト

| スクリプト                                | 内容                                                 |
| ----------------------------------------- | ---------------------------------------------------- |
| `npm run typecheck`                       | `tsc --noEmit`                                       |
| `npm run lint` / `npm run lint:fix`       | ESLint（正しさのみ）                                 |
| `npm run lint:lang`                       | `src/**`・`test/**` に CJK（日本語）が混入すると失敗 |
| `npm run format` / `npm run format:check` | Prettier                                             |
| `npm run test:unit`                       | 高速なユニットテスト（Docker 不要）                  |
| `npm test`                                | 全テスト（integration は Docker 必須）               |
| `npm run test:coverage`                   | カバレッジ（閾値を強制）                             |
| `npm run build`                           | tsup でビルド（ESM + CJS + d.ts）                    |
| `npm run api:check`                       | 公開 API 表面を `etc/commitcourier.api.md` と照合    |

プルリクエストを開く前に `npm run check` が緑であることを確認してください。

## プロジェクト規約

- **言語の分離。** コード（識別子・コメント・TSDoc・利用者が目にする文字列・**git コミット
  メッセージ**）は**英語**で書きます。非英語のテストデータは `test/fixtures/*.json` に置くか
  `\uXXXX` エスケープを使います。`npm run lint:lang` がこれを強制します。
- **`core/` は依存ゼロ・クロスランタイム。** `src/core/` 配下のファイルは third-party も `node:*`
  組込みも import せず、Web 標準グローバル（`crypto.subtle`、`TextEncoder`、`atob`/`btoa` など）
  のみを使い、`Buffer`/`process` は使いません（ESLint で強制）。I/O（DNS/HTTP/DB）は
  `delivery/`・`store/` に置きます。
- **TypeScript strict**。型のみの import は `import type`（`verbatimModuleSyntax`）。
- **整形**は Prettier（2 スペース、ダブルクォート、セミコロンあり、末尾カンマ all、印字幅 100）。
- 状態カラムは Postgres enum ではなく `text + CHECK`。時刻は DB では `timestamptz`、API 境界では
  ミリ秒の `number`。
- **英日ドキュメントは常に同期する。** いくつかのルートドキュメントは英語版 `*.md` と日本語版
  `*.ja.md` を併せて配布します（`README`・`CHANGELOG`・`SECURITY`・`CONTRIBUTING`・
  `CODE_OF_CONDUCT`）。一方を変更したら、**同一 PR** で対となる版も更新し、対が乖離しないように
  します。

利用者向けの真実は `README` です。詳細設計のメモは作者がこのリポジトリ外で管理しており、ここにも npm にも同梱されません。

## 公開 API の変更

公開される型の表面は API Extractor により `etc/commitcourier.api.md` で管理しています。意図して
公開 API を変更した場合は、レポートを再生成してコミットしてください。

```bash
npm run build
npm run api:update
```

CI は `npm run api:check` を実行し、意図しない破壊的変更を検出します。

## プルリクエスト

1. `main` からフォーク／ブランチを作成します。
2. コミットは小さくまとめ、コミットメッセージは英語（命令形）で書きます。
3. 挙動の変更にはテストを追加・更新し、必要に応じて `README`（および `README.ja.md`）と
   `CHANGELOG.md`（`Unreleased`）を更新します。
4. `npm run check`（I/O 経路に触れた場合は `npm test` も）が通ることを確認します。
5. PR を開き、テンプレートを記入します。

貢献いただいた時点で、あなたの貢献がプロジェクトの [MIT ライセンス](./LICENSE)の下で提供される
ことに同意したものとみなされます。
