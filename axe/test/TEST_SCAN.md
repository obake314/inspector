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
  - AAA β停止中のため `includeAAA: true` を送ってもレスポンスは `includeAAA: false`

## T-SCAN-02b: DEEP SCAN タイムアウト

- 手順
  1. 応答が極端に遅い（または接続が滞留する）URLで DEEP SCAN を実行
- 期待結果
  - 8分以内にサーバーが HTTP 504 を返す
  - UI に「DEEP SCANがタイムアウトしました（8分超過）」と表示される
  - DEEP SCAN ボタンがローディング解除されて再操作可能になる
  - 9分時点でクライアント側 AbortController が発火した場合も同様のエラーメッセージが表示される
  - `#timeoutRetryPanel` に対象URLと `PC/SP DEEP` が記録される
  - 「再スキャン対象にセット」で対象URLが単一または一括の入力欄に戻る

## T-SCAN-03: MULTI SCAN

- 手順
  1. `POST /axe/api/ai-evaluate` with `{url, checkItems, viewportPreset}`
- 期待結果
  - `success: true` で `results[]` を返す
  - Gemini未設定時は `model=manual-fallback` かつ `status=manual_required` で返る
  - 正常完了時はレスポンスに `tokenLimited` / `partialResults` フィールドが含まれ、通常は `false`
  - 結果には `reason` に加えて `evidence` / `selector` / `suggestion` が含まれる
  - HTTP 429 / quota exceeded 発生時は HTTP 429、`success: false`、`rateLimited: true`、`quotaExceeded`（判定可能な場合）を返す

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
     - DEEP SCAN / MULTI SCAN / PLAYWRIGHT / EXT SCAN チェックボックス
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

## T-SCAN-12: AI/Sheetsインジケーターと制御

- 手順
  1. AI APIキー**未設定**の状態で画面を開く
  2. MULTI SCAN チェックボックスの状態を確認
  3. Sheets サービスアカウント**未設定**の状態でエクスポートボタンを確認
- 期待結果
  - AI 未設定: インジケーターが `MULTI AI / （モデル名） / KEY: NONE` の3行構造で表示される
  - AI 未設定: MULTI SCAN チェックボックスが `disabled` + 半透明
  - Sheets 未設定: エクスポートボタンが表示されるが `disabled` + 半透明（非表示にはならない）
  - 設定済み時: インジケーターが `KEY: OK`（緑）/ チェックボックス・ボタンが操作可能

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

## T-SCAN-16: DEEP SCAN AAA β停止中

- 手順
  1. `includeAAA: true` で `POST /axe/api/enhanced-check`
- 期待結果
  - AAA β停止中のため返却 `results[]` に AAA SC が含まれない
  - `includeAAA: false` がレスポンスに含まれる

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

## T-SCAN-25: 詳細タブのバッジ数

- 手順
  1. 任意のビューで SCAN 実行（DEEP/MULTI 有効）
  2. PC VIEW のタブ横の数値を確認
- 期待結果
  - タブ横の数値はカード枚数ではなく、SC単位のTOTALスコアを `normalizeScoreToTarget()` で正規化した値と一致する
  - タブ横の数値合計がスコアテーブルTOTAL行の `全項目数` と一致する
  - スコアテーブルの `全項目数 = 緊急 + 重大 + 中程度 + 軽微 + 合格 + 該当なし + 未検証` の整合式はスコアテーブルの各行で成立する
  - BASIC直後の中間描画値が残らず、全スキャン完了後のTOTAL統合値に更新される

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
  - スプレッドシートに生成されるシートは **1 URL = 1 シート**（`[PC]` `[SP]` に分かれない）
  - シート内に `＜PC VIEW＞` 区切り行→PC行→`＜SP VIEW＞` 区切り行→SP行 の順で配置される
  - 表紙シートの集計値（緊急/重大/中程度/軽微/合格/該当なし/未検証）はシートの行数と一致する
  - 表紙の `スコア（%）= pass行数 / (pass行数 + fail行数) × 100`

## T-SCAN-28: 一括チェック `PC+SP` モード

- 手順
  1. ビューを `PC+SP` に選択し、2URL以上を一括チェックで実行（DEEP/MULTI有効）
- 期待結果
  - 進捗チップが `PC BASIC → PC DEEP → PC MULTI → SP BASIC → SP DEEP → SP MULTI` の順で表示される
  - 一括結果が表示された後、各URLをクリックすると `PC VIEW` と `SP VIEW` の両ブロックが表示される
  - PC VIEW と SP VIEW それぞれに BASIC/DEEP/MULTI/TOTAL スコアテーブルが表示される
  - GoogleSheet エクスポートで各 URL が **1シートに統合**される（`[PC]` `[SP]` に分かれない）
  - シート内に `＜PC VIEW＞` / `＜SP VIEW＞` の区切り行が存在する

## T-SCAN-34: 表紙スコアとレポート行数の一致

- 手順
  1. `PC+SP` でSCAN実行後、GoogleSheet エクスポートを実行
  2. 生成されたスプレッドシートの結果シートで「結果」列をフィルタリング
  3. 表紙の「合格」列の値と、シートで「結果=合格」の行数を比較
- 期待結果
  - 表紙の「合格」数 = シートの「合格」行数（区切り行を除く）
  - 表紙の「不合格」数 = シートの「不合格」行数
  - 表紙の「緊急」数 = 結果が不合格かつ重要度が「緊急」の行数
  - 単一スキャン・一括スキャン両方で成立する

## T-SCAN-29: スキャンモード説明UI

- 手順
  1. `DEEP SCAN` / `MULTI SCAN` チェックボックスにカーソルをホバーする
  2. スキャン結果のスコアテーブルを確認（BASIC/DEEP/MULTI行）
- 期待結果
  - DEEP SCAN チェックボックスにホバーするとツールチップに検査内容・所要時間が表示される
  - MULTI SCAN チェックボックスにホバーするとツールチップに評価内容・所要時間・AI APIキー必須が表示される
  - スコアテーブルの BASIC 行に `axe-core 自動検査` のサブテキストが表示される
  - スコアテーブルの DEEP 行に `ヒューリスティック検査` のサブテキストが表示される
  - スコアテーブルの MULTI 行に `AI 検査` のサブテキストが表示される

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

## T-SCAN-35: AIプロバイダー切り替え（Claude Sonnet）

- 手順
  1. 設定モーダルでプロバイダーを `Claude Sonnet 4.6` に変更し Anthropic API Key を入力・保存
  2. ヘッダーステータスバーを確認
  3. MULTI SCAN を実行
- 期待結果
  - ヘッダーの AI インジケーターが `MULTI AI / Claude Sonnet 4.6 / KEY: OK`（3行）で表示される
  - MULTI SCAN が実行される（`manual-fallback` にならない）
  - レスポンスの `model` フィールドが `claude-sonnet-4-6` を含む
  - 各項目に `status` / `confidence` / `reason` / `suggestion` が返る

## T-SCAN-36: AIプロバイダー切り替え（Claude Opus）

- 手順
  1. 設定モーダルでプロバイダーを `Claude Opus 4.6` に変更・保存
  2. MULTI SCAN を実行
- 期待結果
  - レスポンスの `model` フィールドが `claude-opus-4-6` を含む
  - Sonnet と同一フォーマットで結果が返る

## T-SCAN-37: AIプロバイダー未設定時のフォールバック

- 手順
  1. プロバイダーを `Claude Sonnet 4.6` に設定し、Anthropic API Key を空にして保存
  2. MULTI SCAN チェックボックスの状態を確認
  3. 強制的に `/api/ai-evaluate` を呼び出す
- 期待結果
  - MULTI SCAN チェックボックスが `disabled` になる
  - API レスポンスの `model` が `manual-fallback`、全項目 `manual_required`
  - `reason` に `ANTHROPIC_API_KEY が未設定` の旨が含まれる

## T-SCAN-38: AIモデル切り替え（Gemini Pro）

- 手順
  1. 設定モーダルでモデルを `Gemini 2.5 Pro` に変更・保存
  2. MULTI SCAN を実行
- 期待結果
  - `model` フィールドが `gemini-2.5-pro` を含む
  - Flash と同一フォーマットで結果が返る

## T-SCAN-39: AIモデル切り替え（GPT-4o）

- 手順
  1. 設定モーダルでモデルを `GPT-4o` に変更し OpenAI API Key を入力・保存
  2. ヘッダーステータスバーを確認
  3. MULTI SCAN を実行
- 期待結果
  - ヘッダーの AI インジケーターが `MULTI AI / GPT-4o / KEY: OK`（3行）で表示される
  - レスポンスの `model` フィールドが `gpt-4o` を含む

## T-SCAN-40: AIモデル切り替え（o3）

- 手順
  1. 設定モーダルでモデルを `o3` に変更・保存
  2. MULTI SCAN を実行
- 期待結果
  - レスポンスの `model` フィールドが `o3` を含む

## T-SCAN-41: 未設定プロバイダーでのフォールバック（OpenAI）

- 手順
  1. モデルを `GPT-4o` に設定し OpenAI API Key を空にして保存
  2. MULTI SCAN チェックボックスの状態を確認
- 期待結果
  - MULTI SCAN チェックボックスが `disabled` になる
  - API レスポンスの `reason` に `OPENAI_API_KEY が未設定` の旨が含まれる

## T-SCAN-42: AIモデル切り替え（GPT-5）

- 手順
  1. 設定モーダルでモデルを `GPT-5` に変更・保存
  2. ヘッダーステータスバーを確認
  3. MULTI SCAN を実行
- 期待結果
  - ヘッダーの AI インジケーターが `MULTI AI / GPT-5 / KEY: OK`（3行）で表示される
  - レスポンスの `model` フィールドが `gpt-5` を含む
  - o3 と同一フォーマット（`callOpenAIAPI` 経由）で結果が返る

## T-SCAN-43: ヘルプボタン表示

- 手順
  1. ヘッダー右端の `?` ボタンをクリック
  2. モーダルのコンテンツを確認
  3. `×` ボタンをクリック
  4. 再度 `?` ボタンをクリック
  5. モーダル外（オーバーレイ）をクリック
  6. 再度 `?` ボタンをクリック
  7. Escape キーを押す
- 期待結果
  - クリックでモーダルが開く
  - AIモデル比較表（7行: Gemini 2.5 Flash / Gemini 2.5 Pro / Claude Sonnet 4.6 / Claude Opus 4.6 / GPT-4o / o3 / GPT-5）が表示される
  - 各モデルのコスト・精度・用途が表示される
  - `×` ボタンでモーダルが閉じる
  - オーバーレイクリックでモーダルが閉じる
  - Escape キーでモーダルが閉じる

## T-SCAN-45: PLAY SCAN 基本動作

- 手順
  1. 単一スキャンモードで URL を入力
  2. `PLAY SCAN` チェックボックスを有効化（`DEEP SCAN` / `MULTI SCAN` は任意）
  3. `SCAN` ボタンをクリック
- 期待結果
  - プログレスに `PLAY` フェーズチップが表示される
  - スキャン完了後、スコアテーブルに `PLAY` 行が表示される（紫色）
  - PLAY 行に pass/fail/na/unverified のいずれかの数値が表示される（「— 未実行 —」にならない）
  - 詳細タブに `PLAY` バッジ付きのカードが表示される
  - TOTAL 行のスコアが PLAY 結果を含む統合スコアになっている

## T-SCAN-46: PLAY SCAN API レスポンス確認

- 手順
  1. `POST /axe/api/playwright-check` with `{url}`
- 期待結果
  - `success: true`
  - `results[]` が 15 件（2.4.2 / 3.1.1 / 2.1.4 / 1.3.5 / 3.3.2 / 2.5.3 / 4.1.2 / 4.1.3 / 2.4.6 / 1.3.1 / 2.4.7 / 2.1.1 / 2.1.2 / 2.4.3 / 2.4.11）返る
  - 各 result に `sc`, `status`, `violations[]`, `message` が含まれる
  - `status` が `pass` / `fail` / `not_applicable` のいずれか
  - サーバーログに `[PLAY] 完了: 15件` と出力される

## T-SCAN-47: BATCH PLAY SCAN

- 手順
  1. 一括スキャンモードで複数 URL を入力
  2. `PLAY SCAN` チェックボックスを有効化
  3. `BATCH` ボタンをクリック
- 期待結果
  - プログレスに `PLAY SCANNING: <url>` ラベルが URL ごとに表示される
  - 一括スキャン完了後、各 URL の詳細タブに PLAY 結果が表示される

## T-SCAN-44: OpenAI MULTISCANスコアテーブル反映

- 手順
  1. 設定モーダルでモデルを `GPT-4o`（または `o3`）に変更・OpenAI API Key を設定して保存
  2. URL を入力し MULTI SCAN チェックボックスを有効にして SCAN 実行
  3. スキャン完了後のスコアテーブルを確認
- 期待結果
  - MULTI 行が「— 未実行 —」ではなく実際のスコア（数値）で表示される
  - TOTAL 行も MULTI を含む統合スコアになっている
  - サーバーログに `[gpt-4o] AI評価開始:` と出力される（500エラーにならない）

## T-SCAN-48: スキャン中 PLAYWRIGHT チェックボックス無効化

- 手順
  1. 単一スキャンモードで SCAN ボタンを押してスキャンを開始する
  2. スキャン実行中（プログレス表示中）に PLAYWRIGHT チェックボックスとラベルの状態を確認
- 期待結果
  - PLAYWRIGHT チェックボックスが `disabled` になる
  - PLAYWRIGHTラベルが opacity 0.4・pointer-events none になる（DEEP SCAN / MULTI SCAN と同じ挙動）
  - クリア後は PLAYWRIGHT チェックボックスが `disabled` 解除・操作可能に戻る

## T-SCAN-49: スキャン中 BATCH PLAYWRIGHT チェックボックス無効化

- 手順
  1. 一括スキャンモードで `BATCH` ボタンを押してスキャンを開始する
  2. スキャン実行中に PLAYWRIGHT チェックボックスとラベルの状態を確認
- 期待結果
  - 一括スキャン側の PLAYWRIGHT チェックボックスが `disabled` になる
  - PLAYWRIGHTラベルが opacity 0.4・pointer-events none になる
  - クリア後は操作可能に戻る

## T-SCAN-50: 該当なしタブのバッジ数

- 手順
  1. DEEP SCAN または MULTI SCAN を実行し、「該当なし」タブに1件以上のカードが表示される状態にする
  2. 「該当なし」タブのバッジ数を確認
- 期待結果
  - バッジ数が「該当なし」タブに表示されているカード枚数と一致する（0にならない）

## T-SCAN-51: PLAY SCAN API 15項目レスポンス確認

- 手順
  1. `POST /axe/api/playwright-check` with `{url}`
- 期待結果
  - `success: true`
  - `results[]` が 15 件（2.4.2 / 3.1.1 / 2.1.4 / 1.3.5 / 3.3.2 / 2.5.3 / 4.1.2 / 4.1.3 / 2.4.6 / 1.3.1 / 2.4.7 / 2.1.1 / 2.1.2 / 2.4.3 / 2.4.11）返る
  - 各 result に `sc`, `status`, `violations[]`, `message` が含まれる
  - サーバーログに `[PLAY] 完了: 15件` と出力される

## T-SCAN-52: PLAY SCAN 新項目 - ページタイトル（2.4.2）

- 手順
  1. `<title>` が空のページ / 意味のある title があるページで PLAY SCAN を実行
- 期待結果
  - title なしの場合: `sc: "2.4.2"`, `status: "fail"`, violationsに `titleタグがないか空白です` が含まれる
  - title ありの場合: `status: "pass"`, messageにタイトル文字列が含まれる

## T-SCAN-53: PLAY SCAN 新項目 - フォームラベル（3.3.2）

- 手順
  1. ラベルなし input がある / ラベルがある ページで PLAY SCAN を実行
- 期待結果
  - ラベルなし要素がある場合: `sc: "3.3.2"`, `status: "fail"`, violationsにその要素のセレクタが含まれる
  - すべてラベルあり: `status: "pass"`

## T-SCAN-54: EXT SCAN エンドポイント基本動作

- 手順
  1. `POST /axe/api/ext-check` with `{url: "https://example.com"}`
- 期待結果
  - `success: true`
  - `results[]` に `source: "IBM_ACE"` / `"EXT_NATIVE"` / `"EXT_CDP"` のアイテムが含まれる
  - 各 result に `sc`, `status`, `violations[]`, `message` が含まれる
  - サーバーログに `[EXT] 完了: N件` と出力される

## T-SCAN-55: EXT SCAN - IBM Equal Access

- 手順
  1. `<img>` に alt なし / `id` 重複 / `lang` なしのテストページで EXT SCAN を実行
- 期待結果
  - `source: "IBM_ACE"`, `sc: "1.1.1"` の fail 結果が含まれる
  - IBM ACE が検出した violations に要素セレクタまたは HTML スニペットが含まれる

## T-SCAN-56: EXT SCAN - 重複ID検出（4.1.1）

- 手順
  1. `<div id="foo">` が2つ以上あるページで EXT SCAN を実行
- 期待結果
  - `source: "EXT_NATIVE"`, `sc: "4.1.1"`, `status: "fail"`
  - violations に `id="foo" (2件)` の形式で含まれる

## T-SCAN-57: EXT SCAN - ランドマーク検出（2.4.1）

- 手順
  1. `<main>` がないページで EXT SCAN を実行
- 期待結果
  - `source: "EXT_NATIVE"`, `sc: "2.4.1"`, `status: "fail"`
  - violations に `<main>要素またはrole="main"が存在しません` が含まれる

## T-SCAN-58: EXT SCAN チェックボックス - スキャン中無効化

- 手順
  1. EXT SCAN チェックボックスをオンにして SCAN を開始する
- 期待結果
  - スキャン中: `extScanOpt` checkbox が `disabled`、`extScanLabel` が `opacity:0.4`
  - 一括スキャン時: `batchExtOpt` checkbox が `disabled`、`batchExtLabel` が `opacity:0.4`
  - スキャン完了後: disabled 解除・opacity 復元

## T-SCAN-59: EXT SCAN スコアテーブル行表示

- 手順
  1. EXT SCAN をオンにしてスキャン実行
- 期待結果
  - スコアテーブルに `EXT | IBM ACE + 拡張検査` 行が amber色（#D97706）で表示される
  - TOTAL 行に EXT の結果が統合される

## T-SCAN-60: EXT SCAN チェックボックス - 選択状態表示

- 手順
  1. 単一スキャンで EXT SCAN チェックボックスをオンにする
  2. 一括スキャンで EXT SCAN チェックボックスをオンにする
- 期待結果
  - `extScanOpt` / `batchExtOpt` が `checked` になる
  - チェックON時の背景色が amber（#D97706）になり、白いチェックマークが視認できる

## T-SCAN-61: タイムアウトURL再スキャンキュー

- 手順
  1. BASIC / DEEP / MULTI / PLAY / EXT のいずれかで意図的にタイムアウトを発生させる
  2. 単一スキャンと一括スキャンの両方で確認する
  3. `#timeoutRetryPanel` の「再スキャン対象にセット」をクリックする
- 期待結果
  - タイムアウトしたURLが `URL + スキャン種別 + viewport` 単位で重複なく記録される
  - パネルには `PC BASIC` / `SP EXT` のようにビューとスキャン種別が表示される
  - スキャン実行中は「再スキャン対象にセット」「クリア」が disabled
  - 1URLの単一スキャン由来は単一URL入力欄へ戻る
  - 複数URLまたは一括スキャン由来は一括URL欄へ戻り、URL件数表示も更新される
  - 再セット時に前回結果とUIロックがクリアされ、再度SCANできる

## T-SCAN-62: UIフォント割り当て

- 手順
  1. `public/index.html` の Google Fonts 読み込みを確認する
  2. `public/css/style.css` のフォント変数と主要UIセレクタを確認する
- 期待結果
  - Google Fonts の読み込みに旧英数字フォントが含まれない
  - `--font-basic` が `"Noto Sans JP", sans-serif`
  - `--font-latin` が `"Roboto Condensed", sans-serif`
  - `body` は `--font-basic` を既定にする
  - 日本語が入りうる本文・メッセージ・操作ボタンは `--font-basic` のまま表示される
  - 英語・数字のみの固定ラベル、件数、スコア、SC番号、URLスキャン種別は `--font-latin` で表示される

## T-SCAN-63: MULTI SCAN トークン上限警告表示

- 手順
  1. AI API のトークン上限に達する状況（レスポンス途中で切れる）を再現する、または API レスポンスを `tokenLimited: true` でモックして確認する
  2. 単一スキャンで MULTI SCAN を実行し、スコアテーブルと MULTI SCAN ステータスメッセージを確認する
  3. 一括スキャンで MULTI SCAN を実行し、各 URL の詳細表示を切り替えてスコアテーブルを確認する
  4. `clearScan()` を実行してから再スキャンし、バッジが消えることを確認する
- 期待結果
  - `/api/ai-evaluate` レスポンスに `tokenLimited: true` が含まれる場合:
    - スコアテーブルの MULTI 行ラベルに `トークン上限` バッジ（amber: `#d97706`）が表示される
    - MULTI SCAN ステータスメッセージに `トークン上限` バッジと詳細メッセージが表示される
  - `partialResults: true` の場合は `部分応答` バッジが表示される
  - HTTP 429 / quota exceeded の場合は `APIエラー` バッジが表示され、対象項目は `manual_required` のフォールバックカードとして表示される
  - `tokenLimited: false` かつ `partialResults: false` の場合: バッジは表示されない
  - `clearScan()` 後は `lastMultiTokenLimited` / `lastMultiIssue` がリセットされ、次回スキャン後のスコアテーブルにバッジが残らない
  - 一括スキャンで URL を切り替えると、そのURLの `tokenLimited` / issue メタに応じてバッジが更新される
  - PC/SP 両ビューでそれぞれ正しく表示・非表示が切り替わる

## T-SCAN-64: DEEP/PLAY/EXT SC単位統合カード表示

- 手順
  1. DEEP・PLAY・EXT を全て有効化してスキャンを実行する
  2. 同一 SC（例: 2.1.1）が DEEP と PLAY の両方から検出された状態で詳細タブを確認する
  3. 各タブのバッジ数と詳細カード数を確認する
- 期待結果
  - 同一 SC に複数ソースが存在する場合、詳細カードは 1 件にまとまる
  - カード展開時に「Puppeteer検査」「Playwright検査」「IBM Equal Access」などのツール名がソースごとに表示される
  - タブバッジ数は `computeTotalScore()` + `normalizeScoreToTarget()` の SC 単位集計と一致する
  - MULTI 未実行時に、未検証タブへ MULTI の全項目カードが自動追加されない
  - ステータス優先順（fail > unverified > pass > na）で代表ステータスが決まる

## T-SCAN-65: SCAN 実行前予測時間表示

- 手順
  1. ページロード時に `#singleScanEstimate` / `#batchScanEstimate` の内容を確認する
  2. URLを入力し、各スキャンチェックボックスのオン/オフ、viewport 切り替えで表示が変わることを確認する
  3. 一括モードで URL を複数行入力して件数が反映されることを確認する
  4. MULTI のチェックボックスが disabled の場合（AIキー未設定）の動作を確認する
- 期待結果
  - URL 未入力時: "URLを入力すると予測時間を表示します" が現在モード側にだけ表示される
  - 単一モードでは `#batchScanEstimate` が非表示、一括モードでは `#singleScanEstimate` が非表示
  - URL 入力後: `予測時間: 約X〜Y分 / Nページ / PC|SP|PC+SP / BASIC+...` の形式で表示される
  - チェックボックス・viewport・URL 変更のたびに即座に更新される
  - PC+SP 選択時は viewport 数 ×2 として計算される
  - MULTI が disabled の場合は MULTI を除外した予測時間が表示される
  - 一括モードでは有効な URL 行数がページ数として計算される

## T-SCAN-66: favicon.png 表示

- 手順
  1. `public/favicon.png` が存在することを確認する
  2. `public/index.html` の `<head>` に favicon の `<link>` があることを確認する
  3. アプリをブラウザで開き、タブアイコンを確認する
- 期待結果
  - `<link rel="icon" type="image/png" href="favicon.png">` が設定されている
  - ブラウザタブに PNG ファビコンが表示される

## T-SCAN-67: MULTI SCAN 検出内容の具体性

- 手順
  1. MULTI SCAN を実行する、または `/api/ai-evaluate` のレスポンスをモックする
  2. MULTI 詳細カードを展開する
- 期待結果
  - `reason` / `evidence` / `selector` / `suggestion` が取得される
  - 詳細カードに「セレクタ」「根拠」「理由」「改善案」が表示される
  - 汎用的な「確認が必要です」だけの説明にならない

## T-SCAN-68: 設定保存時のAPI残量案内

- 手順
  1. 設定モーダルを開く
  2. MULTI SCAN AIモデルの補足文を確認する
- 期待結果
  - APIキー単体では残トークン数/残クォータを取得できない旨が表示される
  - クォータ不足はMULTI実行時のエラーとして表示される旨が表示される

## T-SCAN-69: UNIFIED詳細カードの描画

- 手順
  1. DEEP / PLAY / EXT のいずれかで BASIC 以外の結果が出るURLをスキャンする
  2. スキャン完了後に PC VIEW の詳細タブを確認する
- 期待結果
  - `renderAllTabs()` が例外なく完了する
  - DEEP / PLAY / EXT の結果が `UNIFIED` カードとして表示される
  - カード展開時に検出ツール名、検出内容、検出箇所が表示される
  - `.tab-num` はBASIC単独ではなくTOTAL統合スコアと一致する

## T-SCAN-70: npm test スモークテスト

- 手順
  1. `cd axe`
  2. `npm test` を実行する
- 期待結果
  - `server.js` の構文チェックが通る
  - `public/index.html` 内インラインスクリプトの構文チェックが通る
  - `gas/ReportGenerator.gs` の構文チェックが通る
  - 終了コードが `0` になる

## T-SCAN-71: MULTI SCAN 実行失敗原因ラベル

- 手順
  1. `/api/ai-evaluate` のレスポンスを `aiErrorType: "api_error"` / `fallback: true` でモックする
  2. `/api/ai-evaluate` のレスポンスを `aiErrorType: "model_unavailable"` でモックする
  3. `/api/ai-evaluate` のレスポンスを `aiErrorType: "json_parse_failed"` でモックする
  4. 単一スキャンと一括スキャンの MULTI 行バッジを確認する
- 期待結果
  - `api_error` は `APIエラー` と表示される
  - `model_unavailable` は `モデル利用不可` と表示される
  - `json_parse_failed` は `JSON解析失敗` と表示される
  - MULTI SCAN の実行失敗原因として `手動確認` バッジは表示されない
  - 対象項目のフォールバック結果は `manual_required` として詳細カードに残る

## T-SCAN-72: 詳細カード開閉クリック範囲

- 手順
  1. DEEP / PLAY / EXT の統合カードが表示されるスキャン結果を開く
  2. `.item-header` をクリックしてカードを展開する
  3. 展開後の `.item-source-section` 内の検出内容・検出箇所をクリックする
  4. 再度 `.item-header` をクリックする
- 期待結果
  - `.item-header` クリックでカードが開閉する
  - `.item-source-section` 内をクリックしてもカードは閉じない
  - `.item-locations` 内の検出箇所テキストを選択・クリックしても開閉状態は変わらない

## T-SCAN-73: DEEP SCAN 2.5.8 スクリーンリーダー専用要素除外

- 手順
  1. `class="sr-only"` / `class="screen-reader-text"` / `class="visually-hidden"` などを持つ 1×1px のリンクまたはボタンを含むページで DEEP SCAN を実行する
  2. 同じページに 24×24px 未満の通常表示リンクまたはボタンも配置して DEEP SCAN を実行する
  3. SC 2.5.8 の結果を確認する
- 期待結果
  - スクリーンリーダー専用 class/id/data 属性を持つ要素は `ターゲットサイズ（24×24px）` の違反に含まれない
  - 通常表示の 24×24px 未満インタラクティブ要素は引き続き違反として検出される
  - 違反表示には class/id を含むセレクタが表示され、どの要素か追跡できる

## T-SCAN-74: GPT APIエラー診断情報

- 手順
  1. 設定モーダルで `GPT-5` を選択して MULTI SCAN を実行する
  2. OpenAI API が 401 / 403 / 404 / 429 / 非対応パラメータを返す状態をモックまたは実環境で再現する
  3. `/api/ai-evaluate` のレスポンスと MULTI 行のエラー詳細を確認する
- 期待結果
  - GPT-5 / o3 / o1系の呼び出しでは `max_completion_tokens` が送信され、`max_tokens` 非対応エラーにならない
  - OpenAI APIエラー時は `causeHint`、`status`、`code`、`errorType`、`param`、`requestId`、`clientRequestId`、`model` が返る
  - 404 / モデル権限エラーは `モデル利用不可` として表示される
  - 401 / 403 / 429 / quota / billing / unsupported parameter は `APIエラー` として表示され、原因候補に確認先が出る
  - UI の詳細文から OpenAI Dashboard / Rate limits / Billing / Project権限のどこを確認すべきか判断できる
