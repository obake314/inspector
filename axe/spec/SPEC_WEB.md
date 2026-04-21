# SPEC_WEB

最終更新: 2026-04-21（EXT SCAN新設: IBM Equal Access + Lighthouse相当 + CDP拡張検査・PLAY/EXT行をレポートに追加）

## 対象

メインのスキャンツール（ACCESSIBILITY INSPECTOR）の構成要素と機能を定義する。

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
- AI未設定/接続失敗時: `success: true` のまま `model: manual-fallback` で全項目 `manual_required` を返す

### PLAY SCAN

- API: `POST /api/playwright-check`
- エンジン: Playwright（`playwright` npm パッケージ、Chromium ヘッドレス）
- 入力: `{ url, basicAuth?, viewportPreset? }`
- 出力: `{ success, url, results: [{ sc, status, violations[], message, tabSequence? }], checkedAt }`
- status: `pass` / `fail` / `not_applicable` / `unverified`
- APIコスト不要（ローカルブラウザ実行）
- タイムアウト: サーバー5分 / クライアント6分

#### PLAY SCAN 検査項目（15項目）

| 項目 | SC | 手法 |
|---|---|---|
| ページタイトル | 2.4.2 | `<title>` の存在・内容を確認 |
| ページ言語 | 3.1.1 | `<html lang>` の有無・形式を確認 |
| 文字キーショートカット | 2.1.4 | `accesskey` 属性の有無を検出 |
| 入力目的の特定 | 1.3.5 | フォーム入力の `autocomplete` 属性の有無を確認 |
| フォームラベル | 3.3.2 | 入力欄に `<label>` / `aria-label` / `aria-labelledby` / `title` があるか確認 |
| 名前の中のラベル | 2.5.3 | 表示テキストと `aria-label` の不一致を検出 |
| アクセシブルネーム監査 | 4.1.2 | `page.accessibility.snapshot()` でインタラクティブ要素の名前・ロールを検証 |
| ステータスメッセージ | 4.1.3 | aria-live / role=status / role=alert の有無を確認 |
| 見出し・ラベル | 2.4.6 | 空見出し・ラベル未設定フォームを検出 |
| 情報と関係性 | 1.3.1 | テーブルヘッダー欠落・fieldset未使用ラジオグループを検出 |
| フォーカス表示（全要素） | 2.4.7 | フォーカス可能要素に outline/box-shadow を確認（最大40要素） |
| キーボード完全到達性 | 2.1.1 | Tab キーシーケンスで到達可能要素を列挙（最大60要素） |
| キーボードトラップ | 2.1.2 | Tab 連続押下で同一要素3回連続 = トラップとして検出（aria-modal 除外） |
| フォーカス順序 | 2.4.3 | tabindex > 0 の有無・視覚的読み順からの逸脱を検出 |
| フォーカスが隠れない（最低限） | 2.4.11 | fixed/sticky 要素によるフォーカス完全隠蔽を検出 |

### EXT SCAN

- API: `POST /api/ext-check`
- エンジン: Playwright + IBM Equal Access Checker + ネイティブDOM検査 + CDP
- npm: `accessibility-checker-engine`（IBM ACE エンジン; `ace-window.js` をページ内注入）
- 入力: `{ url, basicAuth?, viewportPreset? }`
- 出力: `{ success, url, results: [{ source, sc, status, violations[], message, name }], checkedAt }`
- source: `IBM_ACE` / `EXT_NATIVE` / `EXT_CDP`
- status: `pass` / `fail` / `unverified` / `error`
- APIコスト不要（ローカルブラウザ実行）
- タイムアウト: サーバー6分 / クライアント7分

#### EXT SCAN 検査内容

| 種別 | SC | 内容 |
|---|---|---|
| IBM ACE | 複数SC | axe-coreとは異なるルールセット（50+ルール）で違反を検出・SC別に集約 |
| ネイティブ | 4.1.1 | 重複ID検出（`[id]`全列挙） |
| ネイティブ | 2.4.1 | `<main>` / `role="main"` の有無・スキップナビゲーションの確認 |
| ネイティブ | 2.1.1 | スクロール可能要素（overflow:auto/scroll）に tabindex がないものを検出 |
| ネイティブ | 2.4.6 | 見出し階層のスキップ（h1→h3 等）・h1 欠落/複数を検出 |
| CDP拡張 | 2.1.4 | Chrome DevTools Protocol でキーボードイベントリスナーと accesskey を検出 |

#### IBM ACE ルール → WCAG SC マッピング（主要）

`WCAG20_Img_HasAlt`→1.1.1, `RPT_Elem_UniqueId`→4.1.1, `WCAG20_A_HasText`→2.4.4, `WCAG20_Html_HasLang`→3.1.1, `WCAG20_Doc_HasTitle`→2.4.2, `WCAG20_Input_ExplicitLabel`→1.3.1, `Rpt_Aria_ValidRole`→4.1.2, `WCAG21_Style_Viewport`→1.4.4 など50+ルール

#### EXT SCAN スコア行

- スコアテーブルに `EXT` 行を追加（amber色 `#D97706`）
- `computeExtScore()` でSC単位に集約（`computePlayScore()` と同じ方式）
- `computeTotalScore()` の第5引数として EXT 結果を統合
- `extScanOpt` / `batchExtOpt` のチェックON時は `#D97706` 背景で選択状態を明示する

## UI構成

- 単一チェック / 一括チェックのモード切替（初回スキャン後は切替禁止）
- ビュー選択（ラジオ）は単一・一括の両モードで使用可能:
  - `PCのみ`
  - `SPのみ`（iPhone SE）
  - `PC+SP`
- レベル選択: A / AA / AAA（AAAは設定で表示）
- 単一スキャン: URL + `DEEP` / `MULTI` / `PLAYWRIGHT` / `EXT` チェックボックス
- 一括スキャン: URL複数入力（最大10件）
- Basic認証入力（BASIC/DEEPで利用）
- 結果表示:
  - PC VIEW ブロック: PCスコアテーブル（BASIC/DEEP/MULTI/PLAY/EXT/TOTAL）＋ PCスコア詳細タブ
  - SP VIEW ブロック: SPスコアテーブル（BASIC/DEEP/MULTI/PLAY/EXT/TOTAL）＋ SPスコア詳細タブ
  - 各ブロックのスコア詳細タブ（緊急/重大/中程度/軽微/合格/該当なし/未検証）はそれぞれ独立して操作
  - タブ横の数字はそのタブに表示されるカードの実数（items.length）を表示。ただし0件のタブはSC単位集計値にフォールバック
- クリアボタン（エクスポートエリア右端）:
  - スキャン結果・状態を全リセットして再検査可能状態に戻す
  - UIロックを解除（モード切替・レベル・オプション等）
  - AI/Sheets 設定状態を再チェックして適切に有効化

## スキャン実行フロー（単一）

選択されたビューごとに以下を実行する。

1. `check(url, { viewportPreset })`（BASIC）
2. `runEnhancedCheck(true, { viewportPreset })`（DEEP、有効時）
3. `runAIEvaluation(true, { viewportPreset })`（MULTI、有効時）
4. `runPlaywrightCheck(true, { viewportPreset })`（PLAY、有効時）
5. `runExtCheck(true, { viewportPreset })`（EXT、有効時）

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
- フェーズ: BASIC → DEEP（任意）→ MULTI（任意）→ PLAY（任意）→ EXT（任意）
- ビュー選択（`viewportModeWrap`）は単一チェックと共通。選択値に応じて以下のビューで実行:
  - `PCのみ`: `desktop` 固定
  - `SPのみ`: `mobile`（iphone-se）固定
  - `PC+SP`: デスクトップパイプライン完了後、モバイルパイプラインを連続実行
- 進捗チップ（`PC+SP` 時）: 選択フェーズに応じて `PC BASIC → PC DEEP → PC MULTI → PC PLAY → PC EXT → SP BASIC → ...` の順で表示
- 結果格納:
  - `batchResultsData`: PCデータ（SPのみ時はSPデータ）
  - `batchEnhancedResults`: `url → DEEP results`
  - `batchAIResults`: `url → MULTI results`
  - `batchNavConsistency`: SC 3.2.3/3.2.4
  - `batchMobileResultsData`: SPデータ（`PC+SP` 時のみ使用）
  - `batchMobileEnhancedResults`: `url → SP DEEP results`
  - `batchMobileAIResults`: `url → SP MULTI results`
  - `batchPlayResults`: `url → PLAY results`
  - `batchExtResults`: `url → EXT results`
  - `batchMobilePlayResults`: `url → SP PLAY results`
  - `batchMobileExtResults`: `url → SP EXT results`
  - `batchViewportMode`: 実行時の viewportMode 値

## スコアテーブル仕様

### 行ラベルとサブテキスト

| 行 | ラベル | サブテキスト（`.score-row-sub`） | 色 |
|---|---|---|---|
| BASIC | `BASIC` | `axe-core 自動検査` | `#3581B8` |
| DEEP  | `DEEP`  | `ヒューリスティック検査` | `#304C89` |
| MULTI | `MULTI` | `AI 検査` | `#0D7A5F` |
| PLAY  | `PLAY`  | `Playwright 検査` | `#7B4DC8` |
| EXT   | `EXT`   | `IBM ACE + 拡張検査` | `#D97706` |
| TOTAL | `TOTAL` | なし | — |

### スキャンオプションチェックボックス tooltip / 表示

- `deepScanLabel` / `batchDeepLabel`: `title` 属性にDEEP SCANの検査内容・所要時間を記載
- `multiScanLabel` / `batchAILabel`: `title` 属性にMULTI SCANの評価内容・所要時間・AI APIキー必須を記載
- `playScanLabel` / `batchPlayLabel`: `title` 属性にPLAYWRIGHTの検査内容・所要時間を記載
- `extScanLabel` / `batchExtLabel`: `title` 属性にEXT SCANの検査内容・所要時間を記載
- チェックON時の背景色: DEEP `#304C89` / MULTI `#0D7A5F` / PLAY `#7B4DC8` / EXT `#D97706`

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

### 対象レベルによるフィルタリング

- スコアテーブル・詳細カード・レポート出力のいずれも `targetLevel` に基づき SC をフィルタリングする
- レベル `A` 選択時: `WCAG_SC.A` に属するSCのみ表示（AA/AAA項目は除外）
- レベル `AA` 選択時: `WCAG_SC.A + WCAG_SC.AA` のみ（AAAは除外）
- レベル `AAA` 選択時: すべて表示
- フィルタリング対象:
  - BASIC violations / incomplete / passes: `getWcagLevel(tags)` でレベル判定
  - DEEP results: `splitCompositeSc(r.sc).some(sc => scSet.has(sc))` で判定
  - MULTI items: `levelOrder[item.level] <= lim` で判定（従来から変更なし）

### TOTAL算出

- SC単位で重複除去し、以下の優先順位でマージ
- 優先順位: `fail > pass > unverified > na`
  - `fail` が最優先（1つでも違反があればfail）
  - `pass` は `unverified` より優先（BASIC の incomplete が DEEP の pass を打ち消さない）
  - `na` は他のいずれの結果も存在しない場合のみ

## Web系API一覧

- `GET /api/auth-status`
- `POST /api/login`
- `POST /api/settings-get`
- `POST /api/settings-save`
- `POST /api/check`
- `POST /api/batch-check`
- `POST /api/enhanced-check`
- `POST /api/ai-evaluate`
- `POST /api/playwright-check`
- `POST /api/ext-check`
- `GET /api/sheets-status`
- `POST /api/export-report`

## UI操作制約

- スキャン実行後は以下の全要素を操作不可にロック（`lockScanUI()` 呼び出し）
  - 単一/一括モード切替（`#modeToggle`）
  - ビュー選択ラジオ（`PCのみ` / `SPのみ` / `PC+SP`）
  - 対象レベル切替（`.level-select-btn`）
  - `DEEP` / `MULTI` / `PLAYWRIGHT` / `EXT` チェックボックス
  - オプション設定ブロック（`#optionsSection`）
- スキャン中はボタンを `loading` 状態に変更

## SCANアクション配置

- `SCAN` / `BATCH` ボタンと `DEEP` / `MULTI` / `PLAYWRIGHT` / `EXT` チェックボックスはオプション設定ブロックの下（`#scanActionSection`）に配置
- 単一モード: `#singleScanControls` を表示
- 一括モード: `#batchScanControls` を表示（モード切替時に連動）

## 詳細カード仕様

- カード構成: `[バッジ] [SC番号] [レベル] タイトル ▼ / サマリー / 件数 / 検出箇所`
- SC番号は数字のみ表示（"SC" プレフィックスなし）
- カード内 `[No.n]` 要素は表示しない
- バッジ色: BASIC `#3581B8` / DEEP `#304C89` / MULTI `#0D7A5F` / PLAY `#7B4DC8` / EXT `#D97706` / BATCH `#334155`

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

## ヘルプボタン

- ヘッダーの歯車アイコン（`#settingsGear`）横に `?` ボタン（`#helpBtn`）を配置
- クリックで `#helpOverlay` モーダルを表示
- モーダル内容: AIモデル比較表（7モデル、コスト・精度・おすすめ用途）
- 閉じる方法: `×` ボタン / オーバーレイ外クリック / Escape キー
- スタイル: 設定モーダルと同じ `settings-overlay` / `settings-box` クラスを利用

## MULTI SCAN AIプロバイダー

### 選択可能モデル

| 設定値 | モデルID | 提供元 | 必要APIキー |
|---|---|---|---|
| `gemini` | `gemini-2.5-flash` | Google | Gemini API Key |
| `gemini-pro` | `gemini-2.5-pro` | Google | Gemini API Key |
| `claude-sonnet` | `claude-sonnet-4-6` | Anthropic | Anthropic API Key |
| `claude-opus` | `claude-opus-4-6` | Anthropic | Anthropic API Key |
| `gpt-4o` | `gpt-4o` | OpenAI | OpenAI API Key |
| `o3` | `o3` | OpenAI | OpenAI API Key |
| `gpt-5` | `gpt-5` | OpenAI | OpenAI API Key |

### 各社最上位モデル 精度・コスト比較（2026-04 時点）

| モデル             | 1ページあたり目安 | 10ページあたり目安 | 精度 |
| ----------------- | -------------: | ---------------: | ----------------: |
| Gemini 2.5 Flash  | 約01.2〜02.0円 | 約012.4〜020.3円 | 十分：一次スクリーニング、大量巡回|
| Gemini 2.5 Pro    | 約05.0〜08.2円 | 約049.8〜081.7円 | 強い：長文入力、構造化出力、大量処理との両立 |
| Claude Sonnet 4.6 | 約08.4〜13.0円 | 約083.8〜131.5円 | かなり強い：実務の主力、HTML/DOM解釈、改善提案文の質 |
| Claude Opus 4.6   | 約14.0〜22.0円 | 約139.6〜219.2円 | 最上位候補：境界事例、複合判断、説明責任が重い案件 |
| GPT-4o            | 約06.0〜09.2円 | 約059.9〜091.7円 | 強い：画像込みの総合診断、実装バランス |
| o3                | 約04.8〜07.3円 | 約047.9〜073.4円 | かなり強い：難しい判定、例外条件の整理、ロジック重視 |
| GPT-5             | 約18.0〜29.0円 | 約180.0〜290.0円 | 最高峰：論理的推論、複雑な指示解釈、コード生成 |

> **コスト目安**: HTML 15,000文字 + JPEG スクリーンショット 1枚 + 評価項目約55件の場合の概算。
> 実際のコストはページの複雑度・HTML量・選択レベルにより変動する。
> Codex はコード補完用途であり MULTI SCAN には使用しない。

### AIプロバイダー設定

- 設定モーダルのモデル選択（`<select>`）で7モデルから選択
- 選択プロバイダーに対応する API キーを入力
  - Gemini Flash / Pro: `Google Gemini API Key`（Google AI Studio）
  - Claude Sonnet / Opus: `Anthropic API Key`（console.anthropic.com）
  - GPT-4o / o3 / GPT-5: `OpenAI API Key`（platform.openai.com）
- `AI_PROVIDER` 環境変数でも設定可能（優先順位: 設定ファイル > 環境変数）
- API キー未設定時は MULTI SCAN を `disabled`、`manual-fallback` で全項目 `manual_required` を返す

### API呼び出し仕様

| プロバイダー | 関数 | トークンパラメーター | フォーマット指定 |
|---|---|---|---|
| Gemini Flash / Pro | `callGeminiAPI()` | なし（SDK依存） | `responseMimeType: "application/json"` |
| Claude Sonnet / Opus | `callClaudeAPI()` | `max_tokens: 4096` | なし（プロンプト指示） |
| GPT-4o / GPT-5 | `callOpenAIAPI()` | `max_tokens: 4096` | なし（プロンプト指示） |
| o3 / o1系 | `callOpenAIAPI()` | `max_completion_tokens: 8192` | なし（プロンプト指示） |

- `response_format: json_object` は**使用しない**。プロンプトがJSON配列を要求しており `json_object` モードと不整合になるため省略。
- レスポンスパース順序: ① 直接 `JSON.parse`（配列またはオブジェクトラップ対応）→ ② 正規表現で `[...]` を抽出 → ③ `{"index":n,...}` を個別抽出
- オブジェクトラップ形式（例: `{"results":[...]}`）は `Object.values().find(Array.isArray)` で内部配列を取り出す

### ステータスインジケーター

- ヘッダーステータスバーの AI インジケーター（`#statusGemini`）は3行構造で表示
  - 行1（ラベル）: `MULTI AI`（固定・薄表示）
  - 行2（モデル名）: 選択中のモデルフルネーム（例: `Claude Sonnet 4.6`、`Gemini 2.5 Flash`）
  - 行3（キー状態）: `KEY: OK`（緑）/ `KEY: NONE`（グレー）
- ボーダー・テキスト色: `KEY: OK` 時は緑（`--color-multi`）、未設定時はグレー
- ステータス: `NONE`（APIキー未入力）/ `OK`（入力あり）

## AI / Sheets ステータスインジケーター・制御

- ページ起動時と設定保存後に `GET /api/sheets-status` を呼び表示
- ステータス表記: `NONE` / `NG` / `OK`
- AI（選択プロバイダー）: `NONE`（未入力）/ `OK`（入力あり）
- ServiceKey: `NONE`（未入力）/ `NG`（入力あるが認証失敗）/ `OK`（認証成功）
- DriveFolder: `NONE`（未入力）/ `NG`（入力あるが疎通失敗）/ `OK`（疎通成功）
- Sheets（総合）: `NONE`（両方未入力）/ `NG`（どちらかNG）/ `OK`（ServiceKey+DriveFolderともにOK）
- AI 未設定時: MULTI SCAN チェックボックスを `disabled` + 半透明化（ツールチップ表示）
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

- **1 URL = 1 シート**（PC+SP 統合）
  - PC+SP 時: 同一シート内に `＜PC VIEW＞` / `＜SP VIEW＞` 区切り行を挿入し PC 行・SP 行を順に配置
  - PC のみ / SP のみ: 区切り行なし
- 表紙シートに全体集計（緊急/重大/中程度/軽微/合格/該当なし/未検証 列）とページ別スコア一覧
- 表紙の集計値は `computeRowStats()` により算出したレポート行の実数値
  - 緊急/重大/中程度/軽微: 「結果=不合格」行の「重要度」列で分類
  - 合格/未検証/該当なし: 「結果」列の値で直接カウント
  - `passRate = Math.round(pass / (pass + fail) * 100)`（行数ベース）
  - 区切り行（結果列が空）は集計対象外
- 一括検査（`PC+SP` モード）も各 URL を1シートに統合して出力

## GAS 報告書生成

- ファイル: `gas/ReportGenerator.gs` / `gas/appsscript.json`
- 機能: スプレッドシートのメニュー「報告書」→ Google Docs 達成基準リストを生成
- 必要スコープ（`appsscript.json`）:
  - `https://www.googleapis.com/auth/spreadsheets`
  - `https://www.googleapis.com/auth/documents`
  - `https://www.googleapis.com/auth/drive.file`（`DocumentApp.create()` による Drive ファイル作成に必要）
- スコープ変更後は GAS エディタで再認証が必要
- PERMISSION_DENIED 対策: `getReportTabs()` / `readPages_()` / `getCoverUrlMap_()` で `sheet.getType() !== GRID` のシートをスキップ（DATASOURCE/OBJECT シートが PERMISSION_DENIED を引き起こすため）

## フォント仕様

- 本文・UI全般: `"Roboto Condensed", "Poppins", "Noto Sans JP", sans-serif`（CSS変数 `--font-basic`）
- Roboto Condensedは英数字・ラテン文字をカバー、日本語は Noto Sans JP にフォールバック
- Google Fonts: `Roboto+Condensed:wght@400;500;600;700` + `Poppins:wght@400;500;600` + `Noto+Sans+JP:wght@400;500;600`

## 既知の実装差異

1. 除外ルールUI（`data-rule`）は表示のみで未連携
2. Basic認証はBASIC/DEEPには適用、MULTIには未適用
