# TEST_SETTING

スキャン実行前の設定・経路確認項目。

## T-SET-01: 本番URL疎通

- 手順
  1. `curl -I https://inspector.eclo.info/axe/`
- 期待結果
  - HTTP 200

## T-SET-02: `/axe` リダイレクト

- 手順
  1. `curl -kI --resolve inspector.eclo.info:443:127.0.0.1 https://inspector.eclo.info/axe`
- 期待結果
  - `301` または `308` で `/axe/` へ遷移

## T-SET-03: vhost重複なし

- 手順
  1. `grep -Rns "server_name inspector.eclo.info" /etc/nginx/sites-enabled /etc/nginx/conf.d`
- 期待結果
  - 意図した設定のみヒット

## T-SET-04: auth-status API

- 手順
  1. `curl -ks https://inspector.eclo.info/axe/api/auth-status`
- 期待結果
  - JSONで `passwordRequired` を返す

## T-SET-05: login API

- 手順
  1. `POST /axe/api/login` を正/誤パスワードで実行
- 期待結果
  - 正: `success: true`
  - 誤: HTTP 401

## T-SET-05b: パスワードリセット ワンタイムトークン

- 手順
  1. ログイン画面でリセットパネルを開く
  2. `トークンを発行する` を押す、または `POST /axe/api/request-reset` を実行する
  3. サーバーコンソールに表示されたトークンを入力し、新パスワードで `POST /axe/api/reset-password` を実行する
  4. 同じトークンの再利用、誤トークン、5分経過後のトークンも試す
- 期待結果
  - トークン発行APIは `success: true` を返し、トークンはレスポンス本文に露出しない
  - 正しいトークン + 4文字以上の新パスワードで `success: true`
  - 成功後、同じトークンは再利用できない
  - 誤トークンは HTTP 401
  - 期限切れトークンは HTTP 400
  - 4文字未満の新パスワードは HTTP 400

## T-SET-06: settings API

- 手順
  1. `POST /axe/api/settings-get`
  2. `POST /axe/api/settings-save`（AIキー/Folder ID 等を変更）
  3. 再度 `POST /axe/api/settings-get`
- 期待結果
  - 機密値がマスク表示
  - 保存内容が反映
  - AAA βは一時停止中のため `aaaBeta` は常に `false`

## T-SET-07: フロントAPIパス設定

- 手順
  1. `axe/public/index.html` を確認
  2. `axe/server.js` の `/axe/api/` 正規化ミドルウェアを確認
- 期待結果
  - API呼び出しが `apiUrl('/api/...')` を使用
  - `apiUrl(path)` は root `/api/...` を優先して返す
  - root `/api/...` がHTML応答またはJSON 404の場合のみ、`getAlternateApiUrl()` が `/axe/api/...` を候補にする
  - フォールバック再試行時も `method` / `headers` / `body` が維持される
  - `fetch('/api/...')` 直書きがない
  - サーバー側で `/axe/api/...` が `/api/...` に正規化される

## T-SET-08: AI/Sheetsインジケーター反映

- 手順
  1. 設定画面で AI プロバイダーを選択し、対応する API Key / Service Account / Folder ID を保存
  2. ヘッダーの `MULTI AI` インジケーター（3行: ラベル / モデルフルネーム / `KEY: OK|NONE`）を確認
  3. `ServiceKey` / `DriveFolder` / `Sheets` 表示を確認
  4. `MULTI SCAN` と `GoogleSheet` ボタン（単一/一括）状態を確認
- 期待結果
  - AI インジケーター: 選択中プロバイダーの API Key が設定済みなら `KEY: OK`、未設定なら `KEY: NONE`
  - AI インジケーター: モデルフルネーム行が選択中モデルと一致（例: `Claude Opus 4.6`）
  - `ServiceKey: OK` / `DriveFolder: OK` / `Sheets: OK`
  - `MULTI SCAN` チェックボックスが有効化される
  - `reportBtn` と `batchReportBtn` が有効化される
  - `Service Account Key` または `Folder ID` が `NONE` または `NG` の場合、`Sheets` は `NONE/NG` となり、`reportBtn` / `batchReportBtn` は無効化される

## T-SET-09: AAA β 一時停止

- 手順
  1. 設定画面を開く
  2. ページリロード
  3. `POST /axe/api/settings-get` でレスポンス確認
  4. `GET /axe/api/sheets-status` でレスポンス確認
  5. `includeAAA: true` で DEEP SCAN を実行
- 期待結果
  - 設定画面に `AAA（ベータ）` のチェックUIが表示されない
  - `settings-get` / `sheets-status` は `aaaBeta: false`
  - DEEP SCAN 実行中ステータスは `A/AA`
  - `includeAAA: true` を送ってもレスポンスは `includeAAA: false`

## T-SET-10: クリアボタンの動作

- 手順
  1. 任意URLでSCAN実行（DEEP/MULTI有効）
  2. スキャン完了後、エクスポートエリア右端の「クリア」ボタンをクリック
- 期待結果
  - スキャン結果・スコアテーブル・詳細タブがすべてクリアされる
  - UIロック解除: 単一/一括切替・レベル切替・DEEP/MULTI チェックボックス・オプション設定が操作可能に戻る
  - Gemini / Sheets ステータスが再チェックされ、設定状態に応じてボタンが適切に有効/無効化される

## T-SET-11: Basic認証フィールドの表示と動作

- 手順
  1. オプション設定の Basic認証フィールドに user / pass を入力
  2. BASIC SCAN を実行
  3. DEEP SCAN を実行
- 期待結果
  - BASIC SCAN: `basicAuth` が `POST /api/check` に含まれる
  - DEEP SCAN: `basicAuth` が `POST /api/enhanced-check` に含まれる
  - MULTI SCAN: `basicAuth` は送信されない（仕様上未適用）

## T-SET-13: AIプロバイダー切り替えと設定保存

- 手順
  1. 設定画面で `AIモデル` セレクトを `Claude Opus 4.6` に変更
  2. `Anthropic API Key` を入力して保存
  3. ヘッダーの MULTI AI インジケーターを確認
  4. 別モデル（例: GPT-4o）に切り替えて `OpenAI API Key` を入力して保存
  5. ページリロード後、設定が保持されているか確認
- 期待結果
  - 保存後: モデル行が `Claude Opus 4.6`、`KEY: OK` に変わる
  - GPT-4o 切り替え後: モデル行が `GPT-4o`、対応 Key 設定済みなら `KEY: OK`
  - リロード後も選択プロバイダー・各 API Key が維持される
  - MULTI SCAN チェックボックスは API Key が設定されたプロバイダー選択時のみ有効

## T-SET-14: MULTI SCANチェックボックスホバーツールチップ

- 手順
  1. AI API Key **未設定** の状態で MULTI SCAN チェックボックスにホバー
  2. AI API Key **設定済み** の状態で MULTI SCAN チェックボックスにホバー
- 期待結果
  - 未設定時: ツールチップに評価内容・所要時間・「AI APIキー必須」が表示される
  - 設定済み時: チェックボックスが有効化され、ツールチップから「AIキー必須」警告が消える

## T-SET-12: ビュー選択UI（単一/一括）

- 手順
  1. 単一チェックを開き、ビュー選択（`PCのみ / SPのみ / PC+SP`）を確認
  2. 一括チェックに切り替える
  3. 再度単一チェックに戻る
- 期待結果
  - 単一チェック: ビュー選択ラジオが操作可能
  - 一括チェック: ビュー選択ラジオは**無効化されず、操作可能な状態が維持される**
  - 単一チェックへ戻した際もビュー選択は引き続き操作可能

## T-SET-15: PLAY API GET 誤到達時のJSON応答

- 手順
  1. `GET /api/playwright-check` を実行する
  2. `GET /axe/api/playwright-check` を実行する
- 期待結果
  - HTTP 405
  - HTMLではなくJSONで返る
  - `error` に `PLAYWRIGHT APIはPOSTのみ対応` が含まれる
  - `API endpoint not found: GET /api/playwright-check` ではない
