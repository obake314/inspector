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
  - スコアテーブルの DEEP 行に `SC別ヒューリスティック検査 (A/AA)` のサブテキストが表示される
  - スコアテーブルの MULTI 行に `AI 総合評価` のサブテキストが表示される

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
  3. `BATCH SCAN` ボタンをクリック
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
  1. 一括スキャンモードで BATCH SCAN ボタンを押してスキャンを開始する
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
