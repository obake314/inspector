# TEST_SCAN

スキャン実行後の機能確認項目。

## T-SCAN-01: BASIC SCAN

- 手順
  1. `POST /axe/api/check` with `{url, level}`
- 期待結果
  - `success: true`
  - `results.violations / passes / incomplete` を返す

## T-SCAN-02: DEEP SCAN

- 手順
  1. `POST /axe/api/enhanced-check` with `{url, includeAAA}`
- 期待結果
  - `results[]` を返す
  - `status` が `pass/fail/not_applicable/manual_required/error`

## T-SCAN-03: MULTI SCAN

- 手順
  1. `POST /axe/api/ai-evaluate` with `{url, checkItems}`
- 期待結果
  - `success: true` で `results[]` を返す
  - Gemini未設定時は `model=manual-fallback` かつ `status=manual_required` で返る

## T-SCAN-04: BATCH上限

- 手順
  1. `POST /axe/api/batch-check` with 11URL
- 期待結果
  - HTTP 400（最大10件）

## T-SCAN-05: BATCH正常系

- 手順
  1. `POST /axe/api/batch-check` with 2URL以上
- 期待結果
  - `results[]` を返す
  - 条件成立時 `navConsistency` を返す

## T-SCAN-06: JSONパースエラー再発なし

- 手順
  1. `https://inspector.eclo.info/axe/` で SCAN 実行
  2. ブラウザコンソール確認
- 期待結果
  - `Unexpected token '<'` が出ない

## T-SCAN-07: モード切替固定

- 手順
  1. 1回SCAN実行後に単一/一括切替を操作
- 期待結果
  - 仕様どおり切替不可

## T-SCAN-08: スコアテーブル固定項目数（A/AA）

- 手順
  1. `targetLevel=A` で SCAN
  2. `targetLevel=AA` で SCAN
- 期待結果
  - A: 全行 `全項目数=31`
  - AA: 全行 `全項目数=55`

## T-SCAN-09: スコアテーブル整合式

- 手順
  1. 任意レベルで SCAN
  2. BASIC/DEEP/MULTI/TOTAL 各行を確認
- 期待結果
  - `全項目数 = 緊急 + 重大 + 中程度 + 軽微 + 合格 + 該当なし + 未検証`

## T-SCAN-10: スキャン後のUI操作制約

- 手順
  1. 任意URLでSCAN実行（DEEP/MULTI有効）
  2. スキャン完了後に以下を操作:
     - 「単一チェック / 一括チェック」切替
     - 「対象レベル」（A/AA）切替
     - DEEP SCAN / MULTI SCAN チェックボックス
     - オプション設定（Basic認証、除外ルール）
- 期待結果
  - 上記すべてが操作不可（`pointer-events: none` / `disabled`）

## T-SCAN-11: 一括検査サマリーテーブルの値

- 手順
  1. `POST /axe/api/batch-check` で2URL以上を検査（DEEP/MULTI有効）
  2. 返却結果の各URLを `showBatchDetail(idx)` で表示
  3. サマリーテーブルの1行目の値とスコアテーブルのTOTAL行を比較
- 期待結果
  - サマリーテーブルの緊急/重大/中程度/軽微 がスコアテーブルTOTAL行と一致

## T-SCAN-12: Gemini/Sheetsインジケーターと制御

- 手順
  1. Gemini APIキー**未設定**の状態で画面を開く
  2. MULTI SCAN チェックボックスの状態を確認
  3. Sheets サービスアカウント**未設定**の状態でエクスポートボタンを確認
- 期待結果
  - Gemini 未設定: `stGemini` が `--` / MULTI SCAN チェックボックスが `disabled` + 半透明
  - Sheets 未設定: エクスポートボタンが表示されるが `disabled` + 半透明（非表示にはならない）
  - 設定済み時: `OK` 表示 / チェックボックス・ボタンが操作可能

## T-SCAN-13: SC 3.2.3/3.2.4 の情報バー表示

- 手順
  1. 2URL以上で一括検査を実行（ナビゲーション一貫性チェック有効）
  2. 各 URL タブを切り替えて結果エリアを確認
- 期待結果
  - `#results` 先頭に SC 3.2.3/3.2.4 の情報バーが表示される（PASS/FAIL 両方）
  - タブ（緊急/重大/合格 等）の中にカードとしては表示されない

## T-SCAN-14: 詳細カードに [No.n] が表示されない

- 手順
  1. SCAN実行後、任意タブのカードを確認
- 期待結果
  - カードヘッダーに `No.1` / `No.2` などの番号要素が表示されない
