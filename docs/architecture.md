# 構成案と準備手順
このブランチは設計・開発用。現時点でDB・ログイン・管理画面が稼働しているわけではありません。

## 役割
- GitHub: ソース、設計、SQLの変更履歴
- Cloudflare Workers: 公開画面・会員画面・管理画面とAPI、認証・権限確認
- Cloudflare D1: 部員ID・作品・部誌・紹介・イベント・店舗等のデータ
- Cloudflare R2: 非公開PDFと表紙画像。公開画像と会員PDFを別のキー領域で扱う
- 認証:会員・管理者用の別々の共通パスワードをサーバー秘密情報として保持。HMAC署名、HttpOnly/Secure/SameSite Cookie、期限、IP単位の試行制限を実装した開発版を検証中。パスワード変更で既存セッションを無効化。

## 非公開PDFの経路
ブラウザ → Workerでログイン・権限確認 → D1で作品の会員公開状態確認 → R2で該当PDF取得。
R2の公開URLは全文PDFに使わない。会員本文レスポンスは共有キャッシュに入れない。
一般APIは公開フィールドだけを明示的に返し、作者内部ID・R2キー・本文を含めない。

## データモデル
members: 作者の固定IDと現役/卒業生区分。
開発版には部員個別アカウントを設けず、作者記録と共通閲覧ログインを分離。
works: 作者ID、掲載名、作品名、検索本文、会員公開状態。
work_files: PDFの保存キーと版。
introductions: 公開用紹介・抜粋・下書き/公開状態。
issues + issue_works: 部誌と掲載順・掲載ページ。
messages、events、stores + store_issues: 公開情報。
audit_log: 管理者操作の記録。認証用テーブルは認証方式選定後に追加。

## 開発上の注意
SQLは初期案。実運用DBへの適用は未実施。
抽出済み本文の部分一致検索から開始し、実データで速度と日本語の検索品質を確認する。
PDFの本文抽出は別工程として実装し、失敗時も登録が壊れないようにする。
編集と公開内容を分けるため、公開データは確認済み版を参照する。
SQLとR2の保存は単一トランザクションにできないため、失敗時の整合性回復・孤立ファイル掃除を実装する。

## Cloudflare設定で必要になるもの
現在のWorkerの設定確認、D1データベース作成、非公開R2バケット作成、Workerへの接続設定。
本番とテストのDB/バケットは分ける。認証設定・秘密情報はCloudflare側で管理する。
現セッションにはCloudflareアカウントを直接設定するツールがないため、この段階はアカウント側の操作が必要。
費用はプラン・保存量・アクセス量確認後に見積もり、無料で永久運用できるとは約束しない。

## 公式資料
- https://developers.cloudflare.com/d1/
- https://developers.cloudflare.com/r2/
- https://developers.cloudflare.com/workers/runtime-apis/bindings/

## 初期案からの変更
現在の実装用SQLは cms/migrations/0001_cms.sql。design/schema-draft.sql は適用しない。
公開情報はentriesの下書きと公開スナップショットに分け、個別記事種類の入力項目をAPIで検証する。
GUIの目次はまずテキスト入力。作品IDでの目次編集、画像登録、PDFアップロード・抽出は次工程。
詳しい実装済み/未実装一覧は cms/README.md に記載。
