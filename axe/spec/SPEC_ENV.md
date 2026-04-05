# SPEC_ENV

最終更新: 2026-04-05

## 対象

AXE INSPECTOR の前提環境、配信パス、デプロイ手順を定義する。

## 環境構成

- アプリ本体: `axe/server.js` + `axe/public/index.html` + `axe/public/css/style.css`
- 実行方式: Express.js + Puppeteer + PM2
- 配置先: `/var/www/inspector`（VPS）
- 自動デプロイ: `.github/workflows/main.yml`

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
- フロントは `apiUrl('/api/...')` を使い、`/axe` 配下運用時に `/axe/api/...` へ到達させる
- Nginx は `location /axe/` と `location /axe/api/` を同一upstreamに向ける

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
