# SPEC_WEB

最終更新: 2026-04-05

## 対象

メインのスキャンツール（AXE INSPECTOR）の構成要素と機能を定義する。

## スキャンエンジン

### BASIC SCAN

- API: `POST /api/check`
- 入力: `{ url, level, basicAuth? }`
- 出力: `{ success, results: { violations[], passes[], incomplete[] } }`

### DEEP SCAN

- API: `POST /api/enhanced-check`
- 入力: `{ url, includeAAA?, basicAuth? }`
- 出力: `{ success, results: [{ sc, name, status, message, violations[] }], includeAAA }`
- status: `pass` / `fail` / `not_applicable` / `manual_required` / `error`

### MULTI SCAN

- API: `POST /api/ai-evaluate`
- 入力: `{ url, checkItems[] }`
- 出力: `{ success, model, results: [{ index, status, reason, suggestion, confidence? }] }`
- status: `pass` / `fail` / `not_applicable` / `manual_required`

## UI構成

- 単一チェック / 一括チェックのモード切替（初回スキャン後は切替禁止）
- レベル選択: A / AA / AAA（AAAは設定で表示）
- 単一スキャン: URL + `DEEP SCAN` / `MULTI SCAN`
- 一括スキャン: URL複数入力（最大10件）
- Basic認証入力（BASIC/DEEPで利用）
- 結果表示:
  - スコアテーブル（BASIC/DEEP/MULTI/TOTAL）
  - 詳細タブ（critical/serious/moderate/minor/pass/na/unverified）

## スキャン実行フロー（単一）

1. `check(url)`（BASIC）
2. `runEnhancedCheck()`（DEEP、有効時）
3. `runAIEvaluation()`（MULTI、有効時）

都度 `renderAllTabs()` と `renderScanScoreTable()` を更新する。

## 一括検査（Batch）

- API: `POST /api/batch-check`
- 上限: 10 URL
- フェーズ: BASIC → DEEP（任意）→ MULTI（任意）
- 結果格納:
  - `batchResultsData`
  - `batchEnhancedResults`
  - `batchAIResults`
  - `batchNavConsistency`（SC 3.2.3/3.2.4）

## スコアテーブル仕様

### 列

- `全項目数` / `緊急` / `重大` / `中程度` / `軽微` / `合格` / `該当なし` / `未検証`

### 全項目数（固定）

- A: `31`
- AA: `55`（A+AA）
- 参考 AAA: `86`（A+AA+AAA）
- 通常運用（AAAベータ無効時）は A/AA の2パターン

### 行内整合式

`全項目数 = 緊急 + 重大 + 中程度 + 軽微 + 合格 + 該当なし + 未検証`

### TOTAL算出

- SC単位で重複除去し worst result を採用
- 優先順位: `fail > unverified > pass > na`

## Web系API一覧

- `GET /api/auth-status`
- `POST /api/login`
- `POST /api/settings-get`
- `POST /api/settings-save`
- `POST /api/check`
- `POST /api/batch-check`
- `POST /api/enhanced-check`
- `POST /api/ai-evaluate`

## 既知の実装差異

1. 除外ルールUI（`data-rule`）は表示のみで未連携
2. `batchReportBtn` はJS参照のみでDOM未定義
3. Basic認証はBASIC/DEEPには適用、MULTIには未適用
