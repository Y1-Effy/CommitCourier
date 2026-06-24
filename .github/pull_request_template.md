<!-- 貢献ありがとうございます！PR は焦点を絞り、以下を記入してください。 -->
<!-- Thanks for contributing! Please keep the PR focused and fill in the sections below. -->

## 概要 / Summary

<!-- 何を・なぜ変更するか / What does this change do, and why? -->

## 変更の種類 / Type of change

- [ ] バグ修正 / Bug fix
- [ ] リファクタ（挙動不変）/ Refactor (no behavior change)
- [ ] ドキュメント / Documentation
- [ ] テスト・ツール / Tests / tooling
- [ ] その他 / Other:

## チェックリスト / Checklist

- [ ] `npm run check` が通る（typecheck + lint + lint:lang + unit）/ passes
- [ ] delivery / store / dispatcher の I/O 経路に触れた場合 `npm test` が通る（Docker 必須）/ passes if I touched I/O paths (needs Docker)
- [ ] 挙動変更にはテストを追加・更新した / Added or updated tests for behavioral changes
- [ ] 利用者向けの挙動が変わる場合 `README.md` / `README.ja.md` を同期更新した / Updated and kept in sync
- [ ] 関連する場合 `CHANGELOG.md` / `CHANGELOG.ja.md`（`Unreleased`）を更新した / Updated when relevant
- [ ] 公開 API を変更した場合 `npm run api:update` で `etc/commitcourier.api.md` を再生成した / Regenerated
- [ ] `src/**` / `test/**` に CJK を含めていない（コードとコミットは英語）/ No CJK in code (code and commits are English)

## レビュアーへの補足 / Notes for reviewers

<!-- 特に注意してほしい点・トレードオフ・フォローアップ / Anything that needs special attention, trade-offs, follow-ups. -->
