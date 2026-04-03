# AXE INSPECTOR — 仕様書

最終更新: 2026-04-03

---

## 概要

WCAG 2.2 アクセシビリティ自動検査ツール。3種類のスキャンエンジンを統合し、Google Sheetsへのレポート出力機能を持つ。

- **サーバー**: Express.js + Puppeteer、PM2でVPS運用
- **フロントエンド**: `axe/public/index.html`（シングルページ、2283行）
- **サーバー**: `axe/server.js`（3068行）
- **配置**: `/var/www/inspector`（VPS）

---

## スキャンエンジン

### BASIC SCAN（常時実行）
- **エンジン**: axe-core（`@axe-core/puppeteer`）
- **API**: `POST /api/check`
- **入力**: `{ url, level, basicAuth? }`
- **出力**: `{ success, results: { violations[], passes[], incomplete[] } }`
- **特徴**: 静的DOM解析。各violationには `impact`（critical/serious/moderate/minor）、`tags`（wcag番号）、`nodes[]` が含まれる

### DEEP SCAN（ON/OFF選択可）
- **エンジン**: Puppeteer 動的操作
- **API**: `POST /api/enhanced-check`
- **入力**: `{ url, includeAAA?, basicAuth? }`
- **出力**: `{ results: [{ sc, name, status, message, violations[] }], includeAAA }`
- **status値**: `pass` / `fail` / `not_applicable` / `manual_required` / `error`
- **検査基準（Phase 1-3 + Section A/B）**:
  - 1.4.10 リフロー（viewport 320px）
  - 2.5.8 ターゲットサイズ（24×24px）
  - 2.1.2 キーボードトラップ（Tab巡回）
  - 2.4.1 スキップリンク
  - 2.3.3 アニメーション（prefers-reduced-motion）
  - 1.4.12 テキスト間隔
  - 2.4.11/12 フォーカス視認性
  - 3.2.1/3.2.2 予期しない変化（MutationObserver）
  - 3.3.1 エラー識別
  - 4.1.2/4.1.3 ARIA動的属性（expanded/current/live）
  - ほか複数のPhase 2/3基準

### MULTI SCAN（ON/OFF選択可）
- **エンジン**: Gemini AI（gemini-2.5-flash）
- **API**: `POST /api/ai-evaluate`
- **入力**: `{ url, checkItems[] }`
- **出力**: `{ results: [{ index, status, reason, suggestion }] }`
- **status値**: `pass` / `fail` / `not_applicable` / `manual_required`
- **対象**: `manualCheckItems`配列（index.htmlに定義）。targetLevelでフィルタ

---

## UI構成

### スキャン操作エリア
- **WCAG適合レベル選択**: A / AA / AAA ボタン（デフォルト: AA）
- **URL入力**: テキストフィールド
- **SCAN ボタン** (`#runScanBtn`): 常にBASICを実行
- **DEEP SCAN チェックボックス** (`#deepScanOpt`): DEEPも実行するか
- **MULTI SCAN チェックボックス** (`#multiScanOpt`): MULTIも実行するか
- **内部使用の非表示ボタン**: `#checkBtn`, `#enhancedCheckBtn`, `#aiEvaluateBtn`

### スキャン実行フロー（`runScan()`）

```
1. check(url)          → lastResults に保存
                       → renderAllTabs()
                       → renderScanScoreTable(BASIC, null, null)
2. runEnhancedCheck()  → lastEnhancedResults に保存
                       → renderAllTabs()
                       → renderScanScoreTable(BASIC, DEEP, null)
3. runAIEvaluation()   → aiResults に保存
                       → renderAllTabs()
                       → renderScanScoreTable(BASIC, DEEP, MULTI)
```

### スコアテーブル（`#scanScoreTable`）

| 列 | 内容 |
|---|---|
| SCAN | スキャン名（BASIC/DEEP/MULTI/TOTAL） |
| 全項目/スコア | grand total（全スキャン共通）/ 合格率% |
| 緊急 | critical violations（BASICのみ） |
| 重大 | serious violations（BASIC）+ fail（DEEP/MULTI） |
| 中程度 | moderate violations（BASICのみ） |
| 軽微 | minor violations（BASICのみ） |
| 合格 | pass（全スキャン） |
| 該当なし | not_applicable（DEEP/MULTI） |
| 未検証 | incomplete（BASIC）+ manual_required/error（DEEP/MULTI） |

**全項目正規化**: `grandTotal = TOTAL.total`。各スキャン行の `unverified += max(0, grandTotal - scan.total)`。全行で同じ総数を表示。

**TOTALの算出** (`computeTotalScore`): 全スキャンの結果をSC番号でデduplicateし、worst-result（fail > unverified > pass > na）を採用。

### 詳細タブ（7カテゴリ、`renderAllTabs()`）

| タブID | 内容 |
|---|---|
| `#tab-critical` | BASIC critical violations |
| `#tab-serious` | BASIC serious + DEEP fail + MULTI fail |
| `#tab-moderate` | BASIC moderate violations |
| `#tab-minor` | BASIC minor violations |
| `#tab-pass` | BASIC pass + DEEP pass + MULTI pass |
| `#tab-na` | DEEP na + MULTI na |
| `#tab-unverified` | BASIC incomplete + DEEP unverified + MULTI未評価 |

各タブ内にソース別バッジ（BASIC/DEEP/MULTI）付きカードを表示。クリックで展開。

---

## グローバル変数（主要）

| 変数 | 型 | 説明 |
|---|---|---|
| `lastResults` | Object | BASIC SCAN結果（violations, passes, incomplete, url, level） |
| `lastEnhancedResults` | Array\|null | DEEP SCAN結果 |
| `aiResults` | Object | MULTI SCAN結果（インデックス→result） |
| `targetLevel` | String | 現在の適合レベル（A/AA/AAA） |
| `manualCheckItems` | Array | MULTI対象の手動チェック項目定義 |
| `checkedItems` | Set | 手動チェック済みインデックス |

---

## Google Sheets レポート出力

### エクスポートAPI
- **単一URL**: `POST /api/export-report`
- **一括**: 一括検査後に`batchResultsData`から生成

### スプレッドシート構成

**表紙シート**（最初に作成される最後のシート）:
- 作成日時
- 全体スコア（pass率）
- ページ別スコア一覧（HYPERLINK付き）

**各ページシート**（1URL = 1シート）:
- 行1: 列ヘッダーのみ（メタ情報なし）
- 行2〜: データ行

### 11カラム構成（`buildReportRows()`）

| # | 列名 | 内容 |
|---|---|---|
| A | No | 通番 |
| B | 検査種別 | 自動/AI/手動/高精度/一括 |
| C | SC | WCAG SC番号（例: 1.4.11） |
| D | 検査項目 | ルール名（日本語）+ ルールID |
| E | 適合レベル | A/AA/AAA |
| F | 結果 | 合格/不合格/該当なし/未検証/判定不能 |
| G | 場所 | CSSセレクタ等 |
| H | 検出数 | ノード数 |
| I | 重要度 | 緊急/重大/中程度/軽微（自動検査のみ） |
| J | 詳細 | 日本語説明 |
| K | 改善案 | AI提案等 |

### スコア計算（Sheets用）
`computeStats(rows)`: F列（index 5）を集計。`passRate = pass / (pass + fail) * 100`

---

## APIエンドポイント一覧

| メソッド | パス | 説明 |
|---|---|---|
| GET | `/api/auth-status` | ログイン要否確認 |
| POST | `/api/login` | パスワード認証 |
| POST | `/api/settings-get` | 設定取得 |
| POST | `/api/settings-save` | 設定保存（Gemini key等） |
| POST | `/api/check` | BASIC SCAN |
| POST | `/api/batch-check` | 複数URL一括BASIC SCAN |
| POST | `/api/enhanced-check` | DEEP SCAN |
| POST | `/api/ai-evaluate` | MULTI SCAN（Gemini） |
| POST | `/api/export-sheets` | 旧Sheets出力（legacy） |
| POST | `/api/export-report` | Sheets出力（11列・表紙付き） |
| GET | `/api/sheets-status` | Sheets接続状態確認 |
| GET | `/api/sheets-test` | Sheets接続テスト |

---

## SC番号抽出（axe-coreタグから）

```js
// wcag1411 → "1.4.11"
function extractSCFromTags(tags) {
    for (const t of tags) {
        const m = t.match(/^wcag(\d)(\d)(\d{1,2})$/);
        if (m) return `${m[1]}.${m[2]}.${parseInt(m[3], 10)}`;
    }
    return '';
}
```

---

## 一括検査（Batch）

- 複数URLをまとめてBASIC + DEEP + MULTIで検査
- 各フェーズのプログレスバーあり（`#batchPhaseIndicator`）
- 結果は `batchResultsData`, `batchEnhancedResults`, `batchAIResults`, `batchNavConsistency` に保存
- SC 3.2.3/3.2.4 ナビ一貫性は複数URL間比較で判定（`batchNavConsistency`）

---

## デプロイ

```bash
# VPS（/var/www/inspector）
cd /var/www/inspector && git pull && pm2 restart inspector-axe
```
