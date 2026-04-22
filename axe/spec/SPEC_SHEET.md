# SPEC_SHEET

最終更新: 2026-04-22（GAS評価報告書のDocsフォント仕様を追加）

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

- 実行起点: スプレッドシートメニュー `報告書 > アクセシビリティ評価報告書を生成`
- `getReportTabs()` で対象タブを抽出
  - 現行11列形式: `No / 検査種別 / SC / 検査項目 / 適合レベル / 結果 ...`
  - 旧形式: `検査項目番号` ヘッダー
- 入力ダイアログ項目:
  - 社名 / 組織名
  - 対象サイト名
  - 作成者
  - 作成日
  - バージョン
  - 出力対象タブ
- `generateReport()` で Google Docs の「アクセシビリティ評価報告書」を生成
- Docsタイトル形式: `アクセシビリティ評価報告書 - {対象サイト名}（YYYY-MM-DD）`
- Docs本文フォントは `Noto Sans JP`
  - `REPORT_DOC_FONT_FAMILY = 'Noto Sans JP'`
  - 本文デフォルト、表セル、生成後の再帰的な全テキスト要素に適用
- 入力シートは現行11列、旧7列、旧8列形式の読み取りに対応
- シート読み取りは表示値ベース（`getDisplayValues()`）で行い、日付・数式結果・数値表示の崩れを抑える

### Google Docs 出力構成

1. 表紙
2. エグゼクティブサマリー
3. 評価概要
4. 問題点一覧と改善推奨
5. 改善ロードマップ
6. 推奨事項
7. 参照規格・ツール
8. 改訂履歴

### 集計仕様

- `結果` 列を以下に集計する:
  - `合格`
  - `不合格`
  - `要確認`（`判定不能` / `要手動確認` / `エラー` / `未検証`）
  - `対象外`（`該当なし` / `対象外`）
- 問題点一覧は `不合格` 行から生成する
  - `重要度` 列が `緊急` / `重大` / `中程度` / `軽微` の場合は `高` / `中` / `低` に正規化
  - 重要度が空欄の場合は SC に応じて既定の優先度を補完
  - `改善案` が空欄の場合は SC 別の既定改善案を補完
- 改善ロードマップは重要度別に自動生成し、作成日から1か月後・3か月後・6か月後を目安期限にする

### 必要な Apps Script スコープ

- `https://www.googleapis.com/auth/spreadsheets`
- `https://www.googleapis.com/auth/documents`
- `https://www.googleapis.com/auth/drive.file`

## 既知差異

1. GAS の実実行確認は Apps Script 上で行う必要がある。ローカルでは構文チェックのみ可能。
