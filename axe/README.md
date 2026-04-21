# ACCESSIBILITY INSPECTOR

WCAG 2.2 のアクセシビリティ監査を、axe-core、Puppeteer、Playwright、AI評価、IBM Equal Access Checker で実行するWebアプリです。

READMEは初回セットアップと運用の入口です。UI/API/スコア計算の詳細仕様は [SPEC_WEB.md](spec/SPEC_WEB.md) を参照してください。

最終更新: 2026-04-21

## 主な機能

- BASIC: axe-core による自動検査
- DEEP: Puppeteerベースの追加ヒューリスティック検査
- MULTI: Gemini / Claude / OpenAI を選択できるAI評価
- PLAY: Playwright によるキーボード・フォーカス・DOM静的検査
- EXT: IBM Equal Access Checker + ネイティブDOM検査 + CDP拡張検査
- PC / SP / PC+SP ビュー別スキャン
- 単一URL / 最大10URLの一括スキャン
- Google Sheets 出力と GAS による報告書生成

## セットアップ

```bash
cd axe
npm install
```

## 起動

```bash
npm start
```

ブラウザで `http://localhost:3000` を開きます。

## 設定

画面右上の設定から、AI APIキー、Google Sheets連携、アプリパスワードを保存できます。保存内容は `axe/.settings.json` に保持されます。

環境変数でも設定できます。

```bash
PORT=3000
APP_PASSWORD=your-password
AI_PROVIDER=gemini
GEMINI_API_KEY=your-gemini-key
ANTHROPIC_API_KEY=your-anthropic-key
OPENAI_API_KEY=your-openai-key
GOOGLE_SERVICE_ACCOUNT_KEY_PATH=/path/to/service-account.json
GOOGLE_DRIVE_FOLDER_ID=your-drive-folder-id
```

設定値の詳細は [SPEC_ENV.md](spec/SPEC_ENV.md) を参照してください。

## 基本的な使い方

1. URLを入力します。
2. 必要に応じてビュー、対象レベル、Basic認証、除外ルールを設定します。
3. `DEEP` / `MULTI` / `PLAYWRIGHT` / `EXT` を必要に応じて有効化します。
4. `SCAN` または `BATCH` を実行します。
5. スコアテーブルと詳細タブで結果を確認します。
6. 必要に応じてGoogle Sheetsへ出力します。

## ドキュメント

- [SPEC_WEB.md](spec/SPEC_WEB.md): Web UI、スキャンAPI、スコア、表示仕様
- [SPEC_ENV.md](spec/SPEC_ENV.md): 環境、配信、デプロイ仕様
- [SPEC_SHEET.md](spec/SPEC_SHEET.md): Sheets / GAS 報告書仕様
- [TEST_SCAN.md](test/TEST_SCAN.md): スキャン機能の確認項目
- [TEST_SETTING.md](test/TEST_SETTING.md): 設定画面と接続確認項目
- [TEST_OUTPUT.md](test/TEST_OUTPUT.md): Sheets出力確認項目
- [TEST_REPORT.md](test/TEST_REPORT.md): GAS報告書確認項目
- [TEST_DEPLOY.md](test/TEST_DEPLOY.md): デプロイ後確認項目

## 注意事項

- MULTIは選択したAIプロバイダーのAPIキーが必要です。未設定時は手動確認扱いのフォールバックになります。
- PLAYとEXTはローカルブラウザを使うためAPIコストは不要ですが、対象ページやURL数に応じて時間がかかります。
- AI判定は参考情報です。最終判断は人間が行ってください。
