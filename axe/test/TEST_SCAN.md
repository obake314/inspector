# TEST_SCAN

スキャン実行後の機能確認項目。

## T-SCAN-01: BASIC SCAN

- 手順
  1. `POST /axe/api/check` with `{url, level, viewportPreset}`
- 期待結果
  - `success: true`
  - `viewportPreset` がレスポンスに含まれる
  - `results.violations / passes / incomplete` を返す

## T-SCAN-02: DEEP SCAN

- 手順
  1. `POST /axe/api/enhanced-check` with `{url, includeAAA, viewportPreset}`
- 期待結果
  - `viewportPreset` がレスポンスに含まれる
  - `results[]` を返す
  - `status` が `pass/fail/not_applicable/manual_required/error`
  - 正常完了時は UI に「検査完了: N基準を検査」と表示される

## T-SCAN-02b: DEEP SCAN タイムアウト

- 手順
  1. 応答が極端に遅い（または接続が滞留する）URLで DEEP SCAN を実行
- 期待結果
  - 8分以内にサーバーが HTTP 504 を返す
  - UI に「DEEP SCANがタイムアウトしました（8分超過）」と表示される
  - DEEP SCAN ボタンがローディング解除されて再操作可能になる
  - 9分時点でクライアント側 AbortController が発火した場合も同様のエラーメッセージが表示される

## T-SCAN-03: MULTI SCAN

- 手順
  1. `POST /axe/api/ai-evaluate` with `{url, checkItems, viewportPreset}`
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
     - ビュー選択（`PCのみ / SPのみ / PC+SP`）
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

## T-SCAN-15: DEEP SCAN 結果件数（A/AA）

- 手順
  1. `includeAAA: false` で `POST /axe/api/enhanced-check`
- 期待結果
  - 返却 `results[]` に AAA 専用 SC（2.3.3, 2.4.12 等）が含まれない
  - 件数が A/AA 範囲内

## T-SCAN-16: DEEP SCAN 結果件数（AAA含む）

- 手順
  1. `includeAAA: true` で `POST /axe/api/enhanced-check`
- 期待結果
  - 返却 `results[]` に AAA SC が含まれる
  - `includeAAA: true` がレスポンスに含まれる

## T-SCAN-17: BASIC SCAN Basic認証

- 手順
  1. Basic認証が必要なURLに対して `basicAuth: {user, pass}` を付与して `POST /axe/api/check`
- 期待結果
  - 401エラーなく `success: true` を返す

## T-SCAN-18: DEEP SCAN Basic認証

- 手順
  1. Basic認証が必要なURLに対して `basicAuth: {user, pass}` を付与して `POST /axe/api/enhanced-check`
- 期待結果
  - 401エラーなく `results[]` を返す

## T-SCAN-19: クリア後の再スキャン

- 手順
  1. SCAN実行後にクリアボタンをクリック
  2. 別のURLを入力して再度SCAN実行
- 期待結果
  - 前回の結果が残らない
  - スコアテーブル・詳細タブが新しい結果で正常表示される
  - UIロック（モード切替・レベル・チェックボックス）が再びかかる

## T-SCAN-20: ビュー選択 `PCのみ`

- 手順
  1. 単一チェックでビューを `PCのみ` にする
  2. SCANを実行
- 期待結果
  - `PC VIEW` ブロックのみ表示される
  - `SP VIEW` ブロックは非表示
  - `/api/check` `/api/enhanced-check` `/api/ai-evaluate` は `viewportPreset: "desktop"` で実行される

## T-SCAN-21: ビュー選択 `SPのみ`

- 手順
  1. 単一チェックでビューを `SPのみ` にする
  2. SCANを実行
- 期待結果
  - `SP VIEW` ブロックのみ表示される
  - `PC VIEW` ブロックは非表示
  - API実行時の `viewportPreset` は `iphone-se`

## T-SCAN-22: ビュー選択 `PC+SP`

- 手順
  1. 単一チェックでビューを `PC+SP` にする
  2. SCANを実行
- 期待結果
  - `PC VIEW` / `SP VIEW` の2ブロックが表示される
  - 進捗フェーズは `PC BASIC/DEEP/MULTI` の後に `SP BASIC/DEEP/MULTI` が続く
  - それぞれのブロックで `全項目数 = 緊急 + 重大 + 中程度 + 軽微 + 合格 + 該当なし + 未検証` を満たす

## T-SCAN-23: 一括チェック時のビュー選択

- 手順
  1. 一括チェックモードに切り替える
  2. ビューを `PCのみ` / `SPのみ` / `PC+SP` のいずれかに選択して一括チェックを実行
- 期待結果
  - ビュー選択UIが有効な状態で操作できる（無効化されない）
  - `PCのみ`: `/api/batch-check` が `viewportPreset: "desktop"` で実行される
  - `SPのみ`: `/api/batch-check` が `viewportPreset: "iphone-se"` で実行される
  - `PC+SP`: デスクトップ→モバイルの順で2回パイプライン実行される

## T-SCAN-24: PC/SP 詳細タブの独立表示

- 手順
  1. 単一チェックでビューを `PC+SP` にして SCAN 実行
  2. PC VIEW ブロック内のタブ（緊急/重大/... ）を切り替える
  3. SP VIEW ブロック内のタブを切り替える
- 期待結果
  - PC VIEW と SP VIEW それぞれにタブセットが存在する
  - 一方のタブを切り替えてももう一方のタブ選択状態に影響しない
  - PCのタブ詳細には `list-critical-pc` 等の PC 専用リストが描画される
  - SPのタブ詳細には `list-critical-sp` 等の SP 専用リストが描画される

## T-SCAN-25: 詳細タブのバッジ数整合式

- 手順
  1. 任意のビューで SCAN 実行（DEEP/MULTI 有効）
  2. PC VIEW のタブ横の数値を確認
- 期待結果
  - `緊急 + 重大 + 中程度 + 軽微 + 合格 + 該当なし + 未検証 = 全項目数（31/55）`
  - バッジ数はスコアテーブルの TOTAL 行と一致する

## T-SCAN-26: Excel エクスポート（PC+SP）

- 手順
  1. `PC+SP` でSCAN実行後、`Excel` ボタンを押す
- 期待結果
  - `.xlsx` ファイルがダウンロードされる
  - ワークブックに `PC VIEW` シートと `SP VIEW` シートの2シートが存在する
  - 各シート先頭にURL・検査日時・スコアのメタ行が付与されている
  - ヘッダー行 `No/検査種別/SC/…` の後に行データが続く

## T-SCAN-27: GoogleSheet エクスポート（PC+SP）

- 手順
  1. `PC+SP` でSCAN実行後、GoogleSheet エクスポートボタンを押す
- 期待結果
  - スプレッドシートに `[PC]` シートと `[SP]` シートが別々に作成される
  - 表紙シートの列が `緊急 / 重大 / 中程度 / 軽微 / 合格 / 該当なし / 未検証 / スコア` になっている
  - スコア（%）はスコアテーブルの合格率と一致する（pass / 全項目数 基準）

## T-SCAN-28: 一括チェック `PC+SP` モード

- 手順
  1. ビューを `PC+SP` に選択し、2URL以上を一括チェックで実行（DEEP/MULTI有効）
- 期待結果
  - 進捗チップが `PC BASIC → PC DEEP → PC MULTI → SP BASIC → SP DEEP → SP MULTI` の順で表示される
  - 一括結果が表示された後、各URLをクリックすると `PC VIEW` と `SP VIEW` の両ブロックが表示される
  - PC VIEW と SP VIEW それぞれに BASIC/DEEP/MULTI/TOTAL スコアテーブルが表示される
  - GoogleSheet エクスポートで各 URL に `[PC]` `[SP]` の2シートが出力される

## T-SCAN-29: スキャンモード説明UI

- 手順
  1. `DEEP SCAN` / `MULTI SCAN` チェックボックスにカーソルをホバーする
  2. スキャン結果のスコアテーブルを確認（BASIC/DEEP/MULTI行）
- 期待結果
  - DEEP SCAN チェックボックスにホバーするとツールチップに検査内容・所要時間が表示される
  - MULTI SCAN チェックボックスにホバーするとツールチップに評価内容・所要時間・Gemini必須が表示される
  - スコアテーブルの BASIC 行に `axe-core 自動検査` のサブテキストが表示される
  - スコアテーブルの DEEP 行に `SC別ヒューリスティック検査 (A/AA)` のサブテキストが表示される
  - スコアテーブルの MULTI 行に `Gemini AI 総合評価` のサブテキストが表示される

## T-SCAN-32: 対象レベルAでAA項目が表示されない

- 手順
  1. 対象レベルを `A` に設定してSCAN実行（DEEP/MULTI有効）
  2. スコアテーブルの各行（BASIC/DEEP/MULTI/TOTAL）を確認
  3. 詳細タブ（緊急/合格/未検証 等）のカードを確認
  4. Excelエクスポートおよび GoogleSheet エクスポートを実行してレポートを確認
- 期待結果
  - スコアテーブルの全項目数が `31`（Aレベルの固定値）
  - 詳細カードに適合レベル `AA` または `AAA` の項目が表示されない
  - レポート行の「適合レベル」列に `AA` / `AAA` が含まれない
  - DEEP カードは `WCAG_SC.A` に属するSCのみ表示される

## T-SCAN-33: 対象レベルAAでAAA項目が表示されない

- 手順
  1. 対象レベルを `AA` に設定してSCAN実行（DEEP/MULTI有効）
  2. 詳細カード・レポートを確認
- 期待結果
  - 詳細カードに `AAA` 項目が表示されない
  - レポート行の「適合レベル」列に `AAA` が含まれない
  - スコアテーブルの全項目数が `55`

## T-SCAN-31: TOTALスコアの合格数がDEEP合格数を下回らない

- 手順
  1. DEEP SCAN を実行し、合格（pass）が出ている SC を確認する
  2. BASIC SCAN の incomplete（判定不能）が同 SC に存在することを確認する
  3. スコアテーブルの TOTAL 行の「合格」列を確認する
- 期待結果
  - TOTAL行の合格数 ≥ DEEP行の合格数（BASIC の incomplete に DEEP の pass が打ち消されない）
  - 例: DEEP合格15件なら TOTAL合格 ≥ 15件
  - `computeBasicScore / computeDeepScore / computeTotalScore` の `rank` 定義は `{ fail:0, pass:1, unverified:2, na:3 }`

## T-SCAN-30: GoogleSheet シート名重複回避

- 手順
  1. 同じ URL を同じ分内に2回 GoogleSheet エクスポートする
- 期待結果
  - 2回目のエクスポートが「already exists」エラーなく成功する
  - 2回目のシートに `_2` のような suffix が付いてスプレッドシートに追加される
