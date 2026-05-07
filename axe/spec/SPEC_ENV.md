# SPEC_ENV

最終更新: 2026-05-07（開発言語・技術仕様・動作環境を追記）

## 対象

ACCESSIBILITY INSPECTOR の前提環境、配信パス、デプロイ手順を定義する。

## 環境構成

- アプリ本体: `axe/server.js` + `axe/public/index.html` + `axe/public/css/style.css`
- 実行方式: Express.js + Puppeteer + PM2
- 配置先: `/var/www/inspector`（VPS）
- 自動デプロイ: `.github/workflows/main.yml`

## 開発言語・実装方式

- サーバーサイド: JavaScript（Node.js / CommonJS）
- フロントエンド: HTML + CSS + Vanilla JavaScript
- GAS報告書生成: Google Apps Script（V8ランタイム）
- ビルド方式: フロントエンドのビルド工程なし。`express.static()` で `axe/public/` を直接配信
- パッケージ管理: npm + `package-lock.json`（lockfileVersion 3）
- 起動コマンド: `npm start`（`node server.js`）
- テストコマンド: `npm test`（`node scripts/smoke-test.js`）
- 永続設定: `axe/.settings.json`（Git管理外、JSONファイル保存）

## 技術仕様

### サーバー/API

- フレームワーク: Express 4
- API形式: JSON API + 静的ファイル配信
- 主要API: BASIC/DEEP/MULTI/PLAY/EXT スキャン、設定保存、Google Sheets 出力、Google API疎通確認
- API body上限: `express.json({ limit: '50mb' })`
- 認証: アプリパスワードを SHA-256 hash として保存し、設定画面/APIで利用
- 設定優先順位: `.settings.json` を最優先し、不足分を環境変数から補完

### スキャン/検査エンジン

- BASIC: `@axe-core/puppeteer` による axe-core 自動検査
- DEEP: Puppeteer + 独自ヒューリスティック検査
- MULTI: Gemini / Claude / OpenAI SDK 経由のAI評価
- PLAY: Playwright Chromium によるキーボード、フォーカス、DOM静的検査
- EXT: IBM Equal Access Checker Engine（`accessibility-checker-engine`）+ ネイティブDOM検査 + CDP拡張検査
- ブラウザ実行: headless Chromium。`CHROME_PATH` / `PUPPETEER_EXECUTABLE_PATH` 指定時はその実行ファイルを優先

### 外部連携

- AI: Google Gemini API、Anthropic API、OpenAI API
- Google出力: Google Sheets API / Google Drive API
- 認証方式: Google Service Account のJWT Bearer認証
- 報告書生成: Google Sheets から Apps Script を実行し、Google Docs を生成
- GASスコープ: `spreadsheets`、`documents`、`drive.file`

### 主要依存パッケージ

`package-lock.json` で解決される主要バージョンは以下。

| 用途 | パッケージ | バージョン |
|---|---|---|
| Webサーバー | `express` | `4.22.1` |
| 環境変数読込 | `dotenv` | `16.6.1` |
| axe-core連携 | `@axe-core/puppeteer` | `4.11.0` |
| Chromium自動操作 | `puppeteer` | `24.36.0` |
| Playwright検査 | `playwright` | `1.59.1` |
| IBM ACE | `accessibility-checker-engine` | `4.0.16` |
| Gemini SDK | `@google/generative-ai` | `0.21.0` |
| Claude SDK | `@anthropic-ai/sdk` | `0.89.0` |
| OpenAI SDK | `openai` | `6.34.0` |

## 動作環境

### ローカル開発

- 基準ランタイム: Node.js 22.x（`Dockerfile` は `node:22-slim` を使用。`package.json` に `engines` 指定はなし）
- パッケージ導入: `cd axe && npm install`
- 起動: `npm start`
- ローカルURL: `http://localhost:3000`
- Chromium: Puppeteer同梱ブラウザ、または `CHROME_PATH` / `PUPPETEER_EXECUTABLE_PATH` で指定したローカルChrome/Chromium

### 本番/VPS

- OS: Linux VPS（詳細ディストリビューションはリポジトリ内では固定しない）
- 配置ディレクトリ: `/var/www/inspector`
- アプリ作業ディレクトリ: `/var/www/inspector/axe`
- Node.js: 22.x 系を基準
- パッケージ導入: `npm ci --omit=dev`
- プロセス管理: PM2（プロセス名 `inspector-axe`）
- リバースプロキシ: Nginx
- 公開パス: `/axe/`
- APIパス: `/api/...` と `/axe/api/...` の両対応
- ブラウザ依存: Chromium/Google Chrome がサーバー上で実行可能であること
- ネットワーク要件: 検査対象URL、AI API、Google OAuth/Sheets/Drive APIへHTTPS接続できること

### Docker

- ベースイメージ: `node:22-slim`
- 追加パッケージ: `chromium`、`fonts-ipafont-gothic`、`fonts-noto-cjk`
- `NODE_ENV`: `production`
- Chromiumパス: `/usr/bin/chromium`
- 公開ポート: `3000`

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
- `AI_PROVIDER`（デフォルト `gemini`）
- `GEMINI_API_KEY`
- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `GOOGLE_SERVICE_ACCOUNT_KEY_PATH` または `GOOGLE_SERVICE_ACCOUNT_KEY`
- `GOOGLE_DRIVE_FOLDER_ID`
- `CHROME_PATH`（任意）
- `PUPPETEER_EXECUTABLE_PATH`（任意）
- `NODE_ENV`（Dockerでは `production`）

### 設定値の優先順位

- AI Provider: `.settings.json` > `AI_PROVIDER`
- Gemini Key: `.settings.json` > `GEMINI_API_KEY`
- Anthropic Key: `.settings.json` > `ANTHROPIC_API_KEY`
- OpenAI Key: `.settings.json` > `OPENAI_API_KEY`
- Drive Folder: `.settings.json` > `GOOGLE_DRIVE_FOLDER_ID`
- Report Folder: `.settings.json`
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
BUILD_TIME=$(TZ='Asia/Tokyo' date '+%Y-%m-%d %H:%M')
sed -i "s/__BUILD_TIME__/${BUILD_TIME}/g" axe/public/index.html
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
