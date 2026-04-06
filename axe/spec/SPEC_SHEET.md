# SPEC_SHEET

最終更新: 2026-04-06（シートタブ名生成規則を更新・重複時フォールバック追加）

## 対象

Google Sheets の出力構成、およびスプレッドシートからの報告書出力（GAS）を定義する。

## Sheets連携API

- `POST /api/export-sheets`（legacy）
- `POST /api/export-report`（現行）
- `GET /api/sheets-status`
- `GET /api/sheets-test`
- `GET /api/drive-cleanup`
- `POST /api/drive-cleanup`

## `/api/export-report` 仕様

### 入力

- `pages: [{ url, rows, timestamp, stats }]`

### 出力

- `{ success, spreadsheetId, tabs, url }`

### スプレッドシート構成

- 表紙シート（作成日時、全体スコア、ページ別リンク）
- 各ページシート（1URL=1シート）

### シートタブ名生成規則

- 形式: `{tabLabel}_{YYYY-MM-DD}_{HHMMSS}`（秒まで含む6桁）
- `tabLabel`: URL の `hostname + pathname` から `/` `\` `?` `*` `[` `]` `:` を `_` に置換、`%20` も `_` に置換、連続 `_` を1つに正規化、末尾 `_` を除去、先頭50文字
- 同名シートが既に存在する場合: `_2` / `_3` … `_5` の suffix を付けて最大5回リトライ
- 秒を含めることで同一分内に複数回エクスポートしても重複しにくくする

### 行データ列（11列）

1. `No`
2. `検査種別`（自動/AI/手動/高精度/一括）
3. `SC`
4. `検査項目`
5. `適合レベル`
6. `結果`
7. `場所`
8. `検出数`
9. `重要度`
10. `詳細`
11. `改善案`

## スコア計算（Sheets出力用）

- `computeStats(rows)` により `結果` 列を集計
- `passRate = pass / (pass + fail) * 100`

## GAS報告書生成（`axe/gas/ReportGenerator.gs`）

- 実行起点: スプレッドシートメニュー `報告書`
- `getReportTabs()` で対象タブを抽出（`検査項目番号` ヘッダーを基準）
- `generateReport()` で Google Docs の「達成基準リスト」を生成
- 結果マッピング:
  - 合格: `○`
  - 不合格: `×`
  - 判定不能: `△`
  - 未検証: `ー`
- 入力シートは7列/8列形式の読み取りに対応

## 既知差異

1. GAS想定（7/8列）と `/api/export-report`（11列）の列仕様に差異あり
