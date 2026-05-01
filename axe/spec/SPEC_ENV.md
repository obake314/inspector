# SPEC_ENV

最終更新: 2026-04-30（API root優先と/axe互換経路）

## 対象

ACCESSIBILITY INSPECTOR の前提環境、配信パス、デプロイ手順を定義する。

## 環境構成

- アプリ本体: `axe/server.js` + `axe/public/index.html` + `axe/public/css/style.css`
- 実行方式: Express.js + Puppeteer + PM2
- 配置先: `/var/www/inspector`（VPS）
- 自動デプロイ: `.github/workflows/main.yml`

## プロジェクトファイル役割一覧

### ルート

- `.github/workflows/main.yml`: `main` push / 手動実行で VPS 自動デプロイ（`git reset --hard origin/main`、`npm ci --omit=dev`、`pm2 restart`）
- `.gitignore`: ルートで除外するファイル定義（macOSメタデータ、`axe/plan.md` など）
- `axe/`: ACCESSIBILITY INSPECTOR 本体

### `axe/`（アプリ本体）

- `axe/server.js`: Express サーバー本体。認証、設定保存、BASIC/DEEP/MULTI SCAN、Sheets 出力、静的配信 API を提供
- `axe/public/index.html`: フロントエンドの画面構造とクライアントロジック
- `axe/public/css/style.css`: 画面スタイル定義（`index.html` から分離済み）
- `axe/package.json`: Node.js 実行定義（依存関係、`npm start`）
- `axe/package-lock.json`: 依存バージョン固定
- `axe/Dockerfile`: コンテナ実行用イメージ定義（Node + Chromium）
- `axe/.dockerignore`: Docker build context から除外するファイル定義
- `axe/.gitignore`: `axe` 配下で除外するファイル定義（`node_modules`, `.env`, `.settings.json`）
- `axe/.settings.json`: 設定画面から保存される永続設定（Gemini/Google連携情報など、機密。Git管理外）
- `axe/README.md`: セットアップと利用方法
- `axe/plan.md`: 過去の改修計画メモ（実行時未使用の補助ドキュメント）

### `axe/spec/`（仕様書）

- `axe/spec/SPEC_ENV.md`: 環境構成、配信パス、デプロイ仕様
- `axe/spec/SPEC_WEB.md`: スキャンツール本体（UI/API/スコア）の機能仕様
- `axe/spec/SPEC_SHEET.md`: Google Sheets / GAS 連携仕様

### `axe/test/`（テスト項目）

- `axe/test/TEST_DEPLOY.md`: デプロイ後の確認項目
- `axe/test/TEST_SETTING.md`: スキャン前の設定・接続確認項目
- `axe/test/TEST_SCAN.md`: スキャン実行後の動作確認項目
- `axe/test/TEST_OUTPUT.md`: Sheets 出力直後の確認項目
- `axe/test/TEST_REPORT.md`: GAS での報告書生成確認項目

### `axe/gas/`（Google Apps Script）

- `axe/gas/ReportGenerator.gs`: スプレッドシート結果から Google Docs 報告書を生成する GAS 本体
- `axe/gas/appsscript.json`: GAS マニフェスト（タイムゾーン、OAuth スコープ、ランタイム設定）

### `seo/`（別プロダクト）

- `seo/index.html`: SEO MOLE の単一HTMLアプリ
- `seo/img/ogp.jpg`: SEO MOLE の OGP 画像

## 実行設定

### 環境変数（主要）

- `PORT`（デフォルト `3000`）
- `APP_PASSWORD`
- `GEMINI_API_KEY`
- `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` または `GOOGLE_SERVICE_ACCOUNT_KEY`
- `GOOGLE_DRIVE_FOLDER_ID`
- `CHROME_PATH`（任意）

### 設定値の優先順位

- Gemini Key: `.settings.json` > `GEMINI_API_KEY`
- Drive Folder: `.settings.json` > `GOOGLE_DRIVE_FOLDER_ID`
- Service Account: `.settings.json` > `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` > `GOOGLE_SERVICE_ACCOUNT_KEY`
- App Password: `.settings.json`（hash）> `APP_PASSWORD`（起動時にhash化）

### 永続ファイル

- `.settings.json`（機密設定を保持、Git管理外）

## 配信パス仕様

- 本番公開URL: `https://inspector.eclo.info/axe/`
- `/axe` は `/axe/` へリダイレクト
- フロントは `apiUrl('/api/...')` を使い、root `/api/...` を優先して呼び出す
- `/axe` 配下運用時に root API が未公開またはHTML応答になる環境では、クライアントが `/axe/api/...` へ一度だけフォールバックする
- サーバー側は `/axe/api/...` を `/api/...` に正規化し、どちらの経路でも同じAPIハンドラへ到達させる
- Nginx は `location /api/` と `location /axe/api/` を同一upstreamに向ける。`/axe/api/...` から `/api/...` へのHTTPリダイレクトはPOSTがGET化する可能性があるため避ける

## デプロイ手順（現行workflow準拠）

```bash
set -euo pipefail
cd /var/www/inspector
git fetch origin main
git checkout main
git reset --hard origin/main
cd /var/www/inspector/axe
npm ci --omit=dev
pm2 restart inspector-axe --update-env
pm2 save
```

## Docker

- `axe/Dockerfile` は Node 22 + system Chromium 構成
- `npm ci --omit=dev` を使用
- `PUPPETEER_EXECUTABLE_PATH` / `CHROME_PATH` を `/usr/bin/chromium` に固定

## デプロイ完了条件

- GitHub Actions: `completed / success`
- VPS: `git log -1` のSHAが `origin/main` と一致
- PM2: `inspector-axe` が `online`
