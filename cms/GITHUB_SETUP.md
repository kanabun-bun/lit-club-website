# GitHub保存方式への移行

## 実装と現在地

`server/worker.mjs` は `CMS_BACKEND=github` でGitHub保存方式に切り替わります。D1・R2・KVは使用しません。旧D1実装は `server/d1-worker.mjs` に保全しました。Pythonローカル版のSQLite/PDF形式と既存IDも維持しています。

コードの保存先は公開リポジトリ、CMSの保存先は**別の非公開リポジトリ**です。下書き、検索本文、PDF、監査履歴を公開ソースへ入れないでください。公開サイトには、Workersが公開済みの紹介・目次などだけを返します。

日常の登録・編集・公開・取り下げ・削除はWeb管理画面で行います。データ更新では非公開リポジトリにコミットするため、**サイトの再デプロイは不要**です。公開ページを再読み込みすると更新内容を取得します。サイトコード自体の変更は従来通りデプロイが必要です。

## 1. 元データを保全して書き出す

PCのローカルサーバーをControl+Cで終了してから実行してください。SQLiteとPDFを同じ時点で移すために必要です。ZIPを入れ替える前に、旧 `cms/.local-demo` フォルダを残してください。

リポジトリの最上位から、実際の旧データの場所を指定します。

```sh
python3 cms/tools/export_github.py --data-dir /absolute/path/to/old/cms/.local-demo --output cms/.github-export
```

既存データがなく、サイトの初期掲載内容から始める場合だけ次を使います。

```sh
python3 cms/tools/export_github.py --seed --output cms/.github-export
```

- 元SQLiteを読み取り専用で開き、整合性検査を行います。元DB・PDFは変更しません。
- 作者ID、作品ID、記事ID、下書き、公開版、本文検索データを維持します。
- PDFを別フォルダへコピーし、SHA-256付きの保存名にします。
- 登録済みPDFの欠落、破損、不正参照、容量超過があれば移行を停止します。初期データで代用しません。
- 既にある出力先を上書きしません。再実行時は別の出力先を指定してください。
- 出力には `data/state.json`、`pdfs/`、SQLiteバックアップ（既存データ移行時）、`SHA256SUMS.json` が含まれます。
- 出力は非公開データです。公開リポジトリではGitの対象外です。

## 2. 非公開データリポジトリを用意する

GitHubでCMS専用の **Private** リポジトリを作成し、`main` ブランチを初期化します。書き出した **`data/` と `pdfs/` だけ**をそのルートに配置してください。元DBのバックアップとSHA256一覧はPCにも保管します。

公開の `lit-club-website` に入れるのはこの実装コードだけです。Workerは保存先リポジトリの非公開状態を各読み出しで確認し、公開に変更されていたらアクセスを停止します。ただし、リポジトリそのものを公開にするとGitHubから直接データを取得できるため、非公開設定を維持してください。

CMSデータリポジトリへの書き込みで、Cloudflareのソースビルドを起動する連携は不要です。

## 3. Workersを設定する

`cms/wrangler.github.jsonc` の `GITHUB_DATA_REPO` を非公開リポジトリの `所有者/名前` に変更します。`GITHUB_DATA_BRANCH` は実際のブランチ名です。最初は既存サイトと別のプレビューWorker名を使用してください。

GitHubのfine-grained tokenは、CMS専用非公開リポジトリだけを選び、ContentsをRead and write、MetadataをReadに設定します。ソース公開リポジトリへのアクセスは不要です。期限・更新担当を決めてください。

次の値を **Worker Secrets** に設定します。本物の値をコード、コミット、チャットに記載しないでください。

|Secret|用途|
|---|---|
|`GITHUB_TOKEN`|非公開データリポジトリを読み書きするトークン|
|`MEMBER_PASSWORD`|部員・卒業生用。ランダムな16文字以上|
|`ADMIN_PASSWORD`|管理者用。閲覧用と異なるランダムな16文字以上|
|`SESSION_SECRET`|セッション署名用。ランダムな32文字以上|

Wranglerがインストールされている場合、`cms` で以下を実行します。Secretsはプロンプトに入力します。

```sh
wrangler secret put GITHUB_TOKEN --config wrangler.github.jsonc
wrangler secret put MEMBER_PASSWORD --config wrangler.github.jsonc
wrangler secret put ADMIN_PASSWORD --config wrangler.github.jsonc
wrangler secret put SESSION_SECRET --config wrangler.github.jsonc
wrangler deploy --config wrangler.github.jsonc
```

WorkersのRate Limitingバインディング2つを設定ファイルに含めています。namespace_idは同一アカウント内で他の用途と重複しない値に変更してください。ログインはIPごとに5回/60秒、APIは60回/60秒の目安です。未接続時はログイン・データ操作を拒否します。学校などでIPを共有すると複数人に制限がかかる場合があります。Cloudflare拠点ごとの近似制限で、正確な全世界の回数制限や課金停止ではありません。

設定例はWorkers用です。既存URLは `workers.dev` ですが、Cloudflare側の現在のビルド設定は未確認です。Cloudflare Pagesを使用している場合、このWorkerと同じオリジンの `/api/*` にルーティングする設計が別途必要です。

## 4. 動作確認後に切り替える

1. 一般ページで既存紹介・部誌目次・メッセージが表示される。
2. 部員ログイン → 管理者ログイン → 文章を下書き保存。一般ページは変わらない。
3. 公開すると一般ページに反映。取り下げるとAPIから消える。
4. 作者・作品を登録 → PDFを登録 → 検索本文入力 → 会員公開。
5. 未ログインではPDF/APIを取得できず、部員ログインでは閲覧できる。閲覧用パスワードでは編集できない。
6. 別タブで同じ時点の一覧を編集すると競合エラーになり、先の更新を上書きしない。
7. 非公開GitHubの履歴とバックアップが確認できる。

切り替え時に使うのは `cms/public` と `cms/server/worker.mjs` です。ルートの従来HTMLをそのまま配信するビルド設定では、新しい管理機能は動きません。

## 保存と復旧

文章データとPDFの追加・差し替え・削除は同じGitツリー/コミットで確定します。最新ブランチ更新は `force:false` によるfast-forwardだけを許可します。同時変更は409で止め、画面の再読み込みを求めます。破損データ・不明なスキーマは拒否し、自動初期化しません。

PDFは保存名のSHA-256・バイト数・ヘッダーを閲覧時に検査します。削除は最新状態から取り除きますが、Git履歴には旧データが残ります。復旧する場合は、非公開リポジトリをバックアップしてから、復旧対象のコミットを `git revert` するか、既知の正常な `data/state.json` と対応するPDFを一緒に新しいコミットで復元します。force pushや履歴の消去は必要ありません。

## この方式の制約

- GitHub版PDFは一作品10MB以内、現在参照するPDF合計256MB以内、状態JSONは4MB以内です。旧ローカル版は50MBを維持しています。
- PDFを入れ替えてもGit履歴に旧版が残るため、上記の容量制限はリポジトリ全履歴のサイズ制限ではありません。大量の全文PDFには別の保存方式が必要になる場合があります。
- GitHubのAPI制限・接続障害・トークン期限切れでは保存/閲覧できません。成功したようには表示しません。送信後に通信が切れた場合は、再送前に一覧を読み直して保存結果を確認してください。
- 全文検索は入力された本文の部分一致。PDF自動本文抽出・OCR、表紙画像アップロード、作品IDを選ぶ目次GUI、個人別アカウント・権限管理は今回の移植に含みません。
- 共通パスワード方式なので、個人別の閲覧停止・操作人物の識別はできません。PDFのブラウザ保存を完全には防止できません。
- 実Cloudflare/GitHub非公開保存先への接続試験、ブラウザでの見た目確認は、接続設定後に行います。

## 自動テスト

```sh
node --test cms/test/*.test.mjs
python3 -m unittest discover -s cms/test -p 'test_*.py' -v
```

GitHub APIを模擬した統合テストで原子的更新・競合・権限・破損・容量制限を検証します。実サービスでの検証とは区別してください。

参照: [Cloudflare Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)、[GitHub Git references](https://docs.github.com/en/rest/git/refs#update-a-reference)、[GitHub repository contents](https://docs.github.com/en/rest/repos/contents)。
