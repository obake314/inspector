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

## T-SET-06: settings API

- 手順
  1. `POST /axe/api/settings-get`
  2. `POST /axe/api/settings-save`（`aaaBeta` 等を変更）
  3. 再度 `POST /axe/api/settings-get`
- 期待結果
  - 機密値がマスク表示
  - 保存内容が反映

## T-SET-07: フロントAPIパス設定

- 手順
  1. `axe/public/index.html` を確認
- 期待結果
  - API呼び出しが `apiUrl('/api/...')` を使用
  - `fetch('/api/...')` 直書きがない

## T-SET-08: Gemini/Sheetsインジケーター反映

- 手順
  1. 設定画面で Gemini API Key / Service Account / Folder ID を保存
  2. ヘッダーの `Gemini` / `ServiceKey` / `Sheets` 表示を確認
  3. `MULTI SCAN` と `GoogleSheet` ボタン（単一/一括）状態を確認
- 期待結果
  - 設定済みなら `Gemini: OK` / `ServiceKey: OK` / `Sheets: OK`
  - `MULTI SCAN` チェックボックスが有効化される
  - `reportBtn` と `batchReportBtn` が有効化される
  - `Service Account Key` または `Folder ID` が欠ける場合は `Sheets: --` となり、`reportBtn` / `batchReportBtn` は無効化される
