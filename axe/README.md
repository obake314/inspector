# AXE INSPECTOR

axe-core + Puppeteer + **Gemini AI** を使用したアクセシビリティチェッカー。

## 機能

### 1. 自動チェック（axe-core）
- WCAG 2.2 Level A / AA / AAA
- 違反項目の詳細表示
- 修正方法の提案（日本語）

### 2. 🤖 AI自動評価（Gemini）NEW!
手動チェック項目をAIが自動評価:
- スクリーンショット + HTML を解析
- 各項目の合格/不合格を判定
- 改善提案を自動生成
- 確信度も表示

## セットアップ

```bash
cd a11y-checker
npm install
```

## 環境変数

```bash
# Gemini API キー（AI評価に必要）
export GEMINI_API_KEY="your-api-key"

# ポート番号（オプション、デフォルト: 3000）
export PORT=3000
```

### Gemini API キーの取得方法
1. [Google AI Studio](https://makersuite.google.com/app/apikey) にアクセス
2. 「Create API Key」をクリック
3. キーをコピーして環境変数に設定

## 起動

```bash
GEMINI_API_KEY="your-key" npm start
```

http://localhost:3000 を開く。

## 使い方

1. URLを入力して「チェック」
2. 自動チェック結果を確認
3. 「手動チェック」タブに移動
4. 「AI評価を実行」ボタンをクリック
5. AIが各項目を評価（1-2分）
6. 結果を確認、必要に応じて手動で修正

## 費用

Gemini 1.5 Flash を使用:
- 約 $0.01〜0.02 / 1ページ
- 無料枠あり（1日1500リクエストまで）

## API

### POST /api/check
axe-coreによる自動チェック

### POST /api/ai-evaluate  
Gemini AIによる手動項目の自動評価

## 注意事項

- AI評価にはGemini APIキーが必要
- AI判定は参考情報。最終判断は人間が行うこと
- 大量のページをチェックする場合はレート制限に注意
