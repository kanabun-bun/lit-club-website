# DriveのPDF参照（接続前・確認用）

PDFは部のDriveで管理し、サイトには閲覧・関連付けだけを行わせます。
本番はまだ切り替えません。コードブランチは `feature/drive-pdf` です。

## 役割

- PDFの追加・整理・原本削除：部のGoogle Driveで行う。
- サイトの管理画面：作品を選び、Drive PDFのURLを登録し、キーワード・会員公開状態を保存する。
- 「掲載を解除」・作品削除：サイトから参照を外す。Driveの原本は消さない。
- Google認証：専用サービスアカウントの読み取り専用スコープ（共有一覧の確認にはフォルダの編集者権限が必要）。部員にGoogleログインを求めない。
- GitHub：作者・作品・記事とDrive参照情報を保存。既存GitHub PDFも閲覧可能。

## 1. Google側の設定

1. 部が引き継げる管理アカウントで Google Cloud Console https://console.cloud.google.com/ を開く。
2. サイト用プロジェクトを作成するか、部の既存プロジェクトを選択する。
3. 「APIとサービス」→「ライブラリ」で **Google Drive API** を有効にする。
4. 「IAMと管理」→「サービスアカウント」で、サイト用サービスアカウントを作成する。
   プロジェクトの管理者ロールやドメイン全体の委任は不要。
5. サービスアカウントの「キー」→「鍵を追加」→「新しい鍵を作成」→ JSON。
   組織ポリシーでキー発行・外部共有が禁止されている場合は、管理者に確認する。
6. 対象Driveフォルダの「共有」で、サービスアカウントのメールアドレスを **編集者** として追加する（閲覧者では共有一覧の確認が403になるため）。
   一般的なアクセスは **制限付き** のまま。他のフォルダはこのアカウントに共有しない。
7. 接続用JSONはチャットやGitHubに載せず、担当者の安全な保管先に保存する。

対象フォルダ：`1SF0SzqwWQmlDouLO4EKhZGlGEqwmZmMh`

APIのスコープは `drive.readonly` で、書き込み・削除処理は実装していません。
API処理は読み取り専用ですが、サービスアカウント自体はフォルダ編集権限を持ちます。鍵の取扱いと共有先を限定してください。
フォルダ限定スコープではないため、サービスアカウントへの共有対象自体を限定してください。
サービスアカウントの鍵から短期アクセストークンを発行し、個人OAuthの更新トークンは使いません。
鍵の失効・共有解除・API無効化等があると閲覧できなくなるため、引き継ぎに含めます。

## 2. 本番から分離した確認環境

**本番と同じデータブランチでDrive版を試さないでください。** Drive参照を保存したデータは旧版コードで検証できません。

1. 非公開 `kanabun-bun/lit-club-data` のGitHub画面で、最新の `main` から `drive-preview` ブランチを作る。
2. `feature/drive-pdf` のコードを別のフォルダへ展開し、`cms` に移動する。
3. `wrangler.drive-preview.jsonc` のWorker名・保存先ブランチが上記と一致することを確認する。
4. 新しい確認用Workerを設置する。

```sh
npx wrangler@4 deploy --config wrangler.drive-preview.jsonc
```

既存の4秘密情報を、新しいWorkerにも登録する。入力値をチャットには送らない。

```sh
npx wrangler@4 secret put GITHUB_TOKEN --config wrangler.drive-preview.jsonc
npx wrangler@4 secret put MEMBER_PASSWORD --config wrangler.drive-preview.jsonc
npx wrangler@4 secret put ADMIN_PASSWORD --config wrangler.drive-preview.jsonc
npx wrangler@4 secret put SESSION_SECRET --config wrangler.drive-preview.jsonc
```

接続用JSONは、入力ミスを避けるためファイルから標準入力で登録する。
下の引用符内を手元のJSONファイルの絶対パスに置き換える（JSONの中身は入力しない）。

```sh
npx wrangler@4 secret put DRIVE_SERVICE_ACCOUNT_JSON --config wrangler.drive-preview.jsonc < "/absolute/path/service-account.json"
```

## 3. 操作・確認

1. 専用フォルダの **直下** に小さい確認用PDFをアップロードする。
2. 共有は制限付き。URLは `https://drive.google.com/file/d/ファイルID/view`。
3. 確認用サイトの管理画面で作品を選択し、PDFのURL・検索キーワード・会員公開状態を保存する。
4. 部員として閲覧できること、未ログインでは取得できないことを確認する。
5. 掲載解除・作品削除で、Drive原本が残ることを確認する。
6. 他フォルダ・公開リンク・非PDF・10MB超・同時編集を拒否することを確認する。

PDFはDrive上の内容のハッシュを登録時に固定します。同じファイルIDでも本文を更新したら、管理画面で同じURLを再登録してください。それまでは改変検出エラーで配信を止めます。
ファイルを専用フォルダの外へ移動・ゴミ箱へ移動・一般公開するとサイトからの配信は停止します。
ショートカット・サブフォルダ・組織全体共有は対象外です。
「制限付き」のユーザー・グループ共有者はGoogle側で直接読めます。部の管理者など必要な人だけに限定してください。

## 4. 本番移行（確認後）

確認前に本番の設定ファイルやmainデータを変更しません。
確認後、最新本番データをバックアップし、新コードを本番Workerへ設置、同じDrive設定と秘密情報を登録します。
確認ブランチのデータ全体をmainに上書きしてはいけません。本番でその間に行った編集を失います。
本番の各作品について、既存PDFをDriveへコピーし、管理画面で参照を切り替えます。
既存PDFはリンク成功まで使われ続け、リンク失敗時は元の参照を維持します。
リンク切り替えで古いGitHub PDFを自動消去しません。容量の回収・履歴整理はバックアップ後の別作業です。
Drive参照を本番データに保存した後の旧コードへのロールバックは、データの復旧も含めて行う必要があります。

## 制限と確認状況

- 新規Drive PDFは1ファイル10MB以内。Driveの空き容量が別途必要。
- 既存GitHub PDF合計の設定上限は維持。Drive PDFの合計をその枠には加算しない。
- 文章・Drive参照情報は引き続きstate.json（4MB）内。検索はキーワード中心。
- フォルダ内の全PDFを勝手に掲載しない。作品との関連付けと会員公開操作が必要。
- Google/GitHubのAPI障害・制限、Workersの処理時間制限は引き続き適用される。
- 自動テストは模擬API。実フォルダでの接続・スマートフォンを含む実機確認は設定後に行う。

一次資料：
- https://developers.google.com/identity/protocols/oauth2/service-account
- https://developers.google.com/workspace/drive/api/guides/manage-downloads
- https://developers.google.com/workspace/drive/api/guides/manage-sharing

## 部誌の表紙画像

管理画面で「部誌」を追加・修正すると、表紙画像を選択できます。
JPEG・PNG・WebP（入力10MB以内）をブラウザで長辺1600px以下・1MB以内のJPEGに変換します。
表紙は小さい一般公開用画像として非公開GitHubの `covers/` に保存します。Drive PDFとは別です。
下書き保存の表紙は一般には配信しません。公開・取り下げに連動し、差し替え中は以前の公開表紙を維持します。
「表紙を外す」の後、保存・公開して反映してください。旧画像はGitHubの履歴・保存領域に残ります。
ホームの部誌案内は既存の `images/enjaku-54.jpg` を使用します。
