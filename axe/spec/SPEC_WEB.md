# SPEC_WEB

最終更新: 2026-04-06（一括スキャンSPビュー対応・スキャン説明UI改善・ExcelエクスポートへのCSV置換）

## 対象

メインのスキャンツール（AXE INSPECTOR）の構成要素と機能を定義する。

## スキャンエンジン

### BASIC SCAN

- API: `POST /api/check`
- 入力: `{ url, level, basicAuth?, viewportPreset? }`
- `viewportPreset`: `desktop` / `iphone-se`（省略時 `desktop`）
- 出力: `{ success, viewportPreset, results: { violations[], passes[], incomplete[] } }`

### DEEP SCAN

- API: `POST /api/enhanced-check`
- 入力: `{ url, includeAAA?, basicAuth?, viewportPreset? }`
- 出力: `{ success, viewportPreset, results: [{ sc, name, status, message, violations[] }], includeAAA }`
- status: `pass` / `fail` / `not_applicable` / `manual_required` / `error`
- タイムアウト仕様:
  - サーバー側: リクエスト受信から **8分** で 504 を返す
  - クライアント側: fetch に **9分** の AbortController タイムアウトを設定
  - `server.timeout` / `server.keepAliveTimeout`: **10分**（旧: 2分）

### MULTI SCAN

- API: `POST /api/ai-evaluate`
- 入力: `{ url, checkItems[], viewportPreset? }`
- 出力: `{ success, model, results: [{ index, status, reason, suggestion, confidence? }] }`
- status: `pass` / `fail` / `not_applicable` / `manual_required`
- Gemini未設定/接続失敗時: `success: true` のまま `model: manual-fallback` で全項目 `manual_required` を返す

## UI構成

- 単一チェック / 一括チェックのモード切替（初回スキャン後は切替禁止）
- ビュー選択（ラジオ）は単一・一括の両モードで使用可能:
  - `PCのみ`
  - `SPのみ`（iPhone SE）
  - `PC+SP`
- レベル選択: A / AA / AAA（AAAは設定で表示）
- 単一スキャン: URL + `DEEP SCAN` / `MULTI SCAN`
- 一括スキャン: URL複数入力（最大10件）
- Basic認証入力（BASIC/DEEPで利用）
- 結果表示:
  - PC VIEW ブロック: PCスコアテーブル（BASIC/DEEP/MULTI/TOTAL）＋ PCスコア詳細タブ
  - SP VIEW ブロック: SPスコアテーブル（BASIC/DEEP/MULTI/TOTAL）＋ SPスコア詳細タブ
  - 各ブロックのスコア詳細タブ（緊急/重大/中程度/軽微/合格/該当なし/未検証）はそれぞれ独立して操作
  - タブ横の数字はSC単位の集計値（緊急+重大+中程度+軽微+合格+該当なし+未検証 = 全項目数）
- クリアボタン（エクスポートエリア右端）:
  - スキャン結果・状態を全リセットして再検査可能状態に戻す
  - UIロックを解除（モード切替・レベル・オプション等）
  - Gemini/Sheets 設定状態を再チェックして適切に有効化

## スキャン実行フロー（単一）

選択されたビューごとに以下を実行する。

1. `check(url, { viewportPreset })`（BASIC）
2. `runEnhancedCheck(true, { viewportPreset })`（DEEP、有効時）
3. `runAIEvaluation(true, { viewportPreset })`（MULTI、有効時）

ビュー選択別の動作:

- `PCのみ`: Desktopのみ実行
- `SPのみ`: iPhone SEのみ実行
- `PC+SP`: Desktop → iPhone SE の順で両方実行

結果反映:

- スコアテーブルはビュー別ブロックに個別描画
- 詳細タブ/エクスポート用の主データは `PC+SP` 時は PC 優先、`SPのみ` 時は SP を使用

## 一括検査（Batch）

- API: `POST /api/batch-check`
- 入力: `{ urls[], level, basicAuth?, viewportPreset? }`
- 上限: 10 URL
- フェーズ: BASIC → DEEP（任意）→ MULTI（任意）
- ビュー選択（`viewportModeWrap`）は単一チェックと共通。選択値に応じて以下のビューで実行:
  - `PCのみ`: `desktop` 固定
  - `SPのみ`: `mobile`（iphone-se）固定
  - `PC+SP`: デスクトップパイプライン完了後、モバイルパイプラインを連続実行
- 進捗チップ（`PC+SP` 時）: `PC BASIC → PC DEEP → PC MULTI → SP BASIC → SP DEEP → SP MULTI`
- 結果格納:
  - `batchResultsData`: PCデータ（SPのみ時はSPデータ）
  - `batchEnhancedResults`: `url → DEEP results`
  - `batchAIResults`: `url → MULTI results`
  - `batchNavConsistency`: SC 3.2.3/3.2.4
  - `batchMobileResultsData`: SPデータ（`PC+SP` 時のみ使用）
  - `batchMobileEnhancedResults`: `url → SP DEEP results`
  - `batchMobileAIResults`: `url → SP MULTI results`
  - `batchViewportMode`: 実行時の viewportMode 値

## スコアテーブル仕様

### 行ラベルとサブテキスト

| 行 | ラベル | サブテキスト（`.score-row-sub`） |
|---|---|---|
| BASIC | `BASIC` | `axe-core 自動検査` |
| DEEP  | `DEEP`  | `SC別ヒューリスティック検査 (A/AA)` または `(A/AA/AAA β)` |
| MULTI | `MULTI` | `Gemini AI 総合評価` |
| TOTAL | `TOTAL` | なし |

### DEEP / MULTI チェックボックス tooltip

- `deepScanLabel` / `batchDeepLabel`: `title` 属性にDEEP SCANの検査内容・所要時間を記載
- `multiScanLabel` / `batchAILabel`: `title` 属性にMULTI SCANの評価内容・所要時間・Gemini必須を記載

### 列

- `全項目数` / `緊急` / `重大` / `中程度` / `軽微` / `合格` / `該当なし` / `未検証`

### 全項目数（固定）

- A: `31`
- AA: `55`（A+AA）
- 参考 AAA: `86`（A+AA+AAA）
- 通常運用（AAAベータ無効時）は A/AA の2パターン

### 行内整合式

`全項目数 = 緊急 + 重大 + 中程度 + 軽微 + 合格 + 該当なし + 未検証`

この整合式はスコアテーブルの各行だけでなく、詳細タブ横のバッジ数でも同様に成立する。
バッジ数は SC 単位の TOTAL スコア（`computeTotalScore` 出力）を使用する。

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

## UI操作制約

- スキャン実行後は以下の全要素を操作不可にロック（`lockScanUI()` 呼び出し）
  - 単一/一括モード切替（`#modeToggle`）
  - ビュー選択ラジオ（`PCのみ` / `SPのみ` / `PC+SP`）
  - 対象レベル切替（`.level-select-btn`）
  - DEEP SCAN / MULTI SCAN チェックボックス
  - オプション設定ブロック（`#optionsSection`）
- スキャン中はボタンを `loading` 状態に変更

## SCANアクション配置

- SCAN / DEEP SCAN / MULTI SCAN ボタン・チェックボックスはオプション設定ブロックの下（`#scanActionSection`）に配置
- 単一モード: `#singleScanControls` を表示
- 一括モード: `#batchScanControls` を表示（モード切替時に連動）

## 詳細カード仕様

- カード構成: `[バッジ] [SC番号] [レベル] タイトル ▼ / サマリー / 件数 / 検出箇所`
- SC番号は数字のみ表示（"SC" プレフィックスなし）
- カード内 `[No.n]` 要素は表示しない
- バッジ色: BASIC `#3581B8` / DEEP `#304C89` / MULTI `#0D7A5F` / BATCH `#334155`

## 一括検査サマリーテーブル

- 列: URL / 全項目スコア / 緊急 / 重大 / 中程度 / 軽微 / 合格 / 該当なし / 未検証
- 各行の値は当該ページの TOTAL スコア（BASIC+DEEP+MULTI 統合後の SC 単位重複除去値）
- 行クリックで `showBatchDetail(idx)` → スコアテーブルと詳細タブを更新
- `showBatchDetail` はグローバル状態 `lastEnhancedResults` / `aiResults` を当該ページのものに差し替えてから `renderAllTabs()` を呼ぶ

## SC 3.2.3 / 3.2.4 ナビゲーション一貫性

- 一括検査後の結果は `batchNavConsistency` に格納
- カード表示はしない
- `showBatchDetail()` で各 URL タブを表示するたびに `renderNavBar()` が `#results` の先頭に情報バーとして挿入
- PASS/FAIL にかかわらず全 URL タブで常に表示

## Gemini / Sheets ステータスインジケーター・制御

- ページ起動時と設定保存後に `GET /api/sheets-status` を呼び表示
- ステータス表記: `NONE` / `NG` / `OK`
- Gemini: `NONE`（未入力）/ `OK`（入力あり）
- ServiceKey: `NONE`（未入力）/ `NG`（入力あるが認証失敗）/ `OK`（認証成功）
- DriveFolder: `NONE`（未入力）/ `NG`（入力あるが疎通失敗）/ `OK`（疎通成功）
- Sheets（総合）: `NONE`（両方未入力）/ `NG`（どちらかNG）/ `OK`（ServiceKey+DriveFolderともにOK）
- Gemini 未設定時: MULTI SCAN チェックボックスを `disabled` + 半透明化（ツールチップ表示）
- Sheets 未設定時: エクスポートボタンを `disabled` + 半透明化（非表示にはしない）
  - Sheets有効化判定は `Service Account Key` と `Drive Folder ID` の両方が `OK` であること
- 一括検査領域にも `batchReportBtn`（GoogleSheet）を配置し、Sheets設定状態に連動して有効/無効を切り替える

## エクスポート仕様

### Excel エクスポート（クライアント側）

- ライブラリ: SheetJS（xlsx 0.20.3、CDN読み込み）
- ファイル名: `wcag-report-YYYY-MM-DD.xlsx`
- シート構成:
  - `PC VIEW` シート: URL・検査日時・スコアメタ行 → ヘッダー行 → 行データ
  - `SP VIEW` シート: SP結果が存在する場合のみ追加
- ヘッダー列: `No` / `検査種別` / `SC` / `検査項目` / `適合レベル` / `結果` / `場所` / `検出数` / `重要度` / `詳細` / `改善案`
- 列幅（`wch`）: No=4, 検査種別=8, SC=6, 検査項目=30, 適合レベル=6, 結果=8, 場所=20, 検出数=6, 重要度=8, 詳細=30, 改善案=20
- 旧 CSV エクスポートボタン（`#csvBtn`）を `Excel` ボタンに置換済み

### Google Sheets エクスポート

- PC と SP は別シートとして出力（例: `example.com/ [PC]`, `example.com/ [SP]`）
- 表紙シートに全体集計（緊急/重大/中程度/軽微/合格/該当なし/未検証 列）とページ別スコア一覧
- スコア（`passRate`）= `pass / 全項目数 × 100`（全項目数基準、`pass / checkable` ではない）
- 一括検査（`PC+SP` モード）は各 URL に対して `[PC]` / `[SP]` の2ページを交互に出力
- 一括検査（PCのみ / SPのみ）は各 URL を1ページとして出力

## 既知の実装差異

1. 除外ルールUI（`data-rule`）は表示のみで未連携
2. Basic認証はBASIC/DEEPには適用、MULTIには未適用
