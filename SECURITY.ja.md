# セキュリティポリシー

🇬🇧 English: **[SECURITY.md](./SECURITY.md)**（こちらがメインです）

## 脆弱性の報告

**セキュリティ脆弱性を、公開の GitHub Issue・Pull Request・Discussion で報告しないでください。**

代わりに、GitHub の非公開アドバイザリ機能から報告してください。

1. 新しいアドバイザリを作成する：**https://github.com/Y1-Effy/CommitCourier/security/advisories/new**（または、リポジトリの **Security** タブ → **Report a vulnerability**）。
2. 明確な説明、影響を受けるバージョン、可能であれば最小再現手順と観測された影響を記載する。

> メンテナ向け：この機能を使うには、リポジトリで **Private vulnerability reporting** を有効化しておく必要があります（Settings → Code security and analysis）。

修正と[協調的開示（coordinated disclosure）](https://www.cisa.gov/coordinated-vulnerability-disclosure-process)をあなたと調整し、匿名を希望されない限りアドバイザリ上でクレジットします。

## サポート対象バージョン

CommitCourier はプレリリースです。`1.0.0` までは、最新の `0.x` リリースのみがセキュリティ修正の対象です。

| バージョン       | サポート |
| ---------------- | -------- |
| 最新の `0.x`     | ✅       |
| それ以前の `0.x` | ❌       |

## 対応の目安

本プロジェクトはベストエフォートで運営される小規模 OSS です。報告には数営業日以内の受領確認を目標とし、調査・修正の進捗を随時共有します。正式な SLA やバグバウンティは提供しません。

## セキュリティモデルと責務範囲

CommitCourier はセキュリティ機微な責務を扱うため、ライブラリが守るものと、利用者（インテグレータ）の責務として残るものを明示します。

### CommitCourier が守るもの

- **Outbound SSRF。** SSRF 防御は既定で有効で、プライベート／ループバック／リンクローカル／クラウドメタデータ宛先を遮断します。DNS リバインディング対策として、**名前解決後の IP** に対して再検証します。
- **改ざん・なりすましの検出。** 配信は Standard Webhooks（`{id}.{timestamp}.{body}` に対する HMAC-SHA256）で署名され、受信側が真正性と完全性を検証できます。
- **台帳での secret の取り扱い。** 配信台帳はリクエストヘッダを記録しますが、**署名 secret 自体は決して保存しません**。応答本文は設定可能なスニペットサイズに切り詰めます。
- **fail-closed な enqueue。** Outbox 行は業務トランザクションの中で書かれるため、rollback された業務書き込みに対して webhook が送られることはありません。

### 利用者の責務（ライブラリのスコープ外）

- **secret の保管時暗号化。** 署名 secret（`webhook_outbox.secret_snapshot` および `webhook_endpoints.secret`）は、アプリが書き込んだままの形で保存されます。保管時の暗号化はデータベース側の責務です（任意の暗号化カラム対応は将来作業）。
- **受信側の検証と冪等処理。** CommitCourier は at-least-once 配信と idempotency key を提供しますが、署名検証とイベントの重複排除は受信側の責務です。
- **SSRF 防御の無効化。** `ssrf.blockPrivateRanges: false`（または allowlist へのホスト追加）は内部宛先への到達性を再び有効にします。これは明示的かつ警告付きのオプトインであり、その結果生じる露出は利用者の判断です。
- **トランスポート保護と認証情報。** HTTPS エンドポイントを使用し、DB 認証情報や署名 secret をソース管理に含めないでください。

## 脆弱性として扱わないもの

以下は文書化された設計上の判断であり、セキュリティ上の欠陥ではありません（[README](./README.ja.md) の「保証と非目標」セクション参照）。

- 受信側での exactly-once な「効果」が無いこと（設計上、配信は at-least-once です）。
- エンドポイント横断の全順序保証が無いこと（既定の配信は順不同です）。
- SSRF 防御を明示的に無効化した後に内部宛先へ到達できること。
- 本ライブラリが対象とする中〜中規模を超える負荷下での挙動。
