# スキャンエンジン適性サマリー (WCAG 2.2 A/AA)

本ドキュメントは、ACCESSIBILITY INSPECTOR に搭載されている5つのスキャンエンジン（BASIC, EXT, DEEP, PLAY, MULTI）が、WCAG 2.2 の各達成基準に対してどの程度の精度で適性を持っているかをまとめたものです。

## スキャンエンジンの役割と強み

- **BASIC (`axe-core`)**: 静的DOM解析。属性の欠落や基本的なHTML/ARIAの文法エラーを高速かつ決定論的に検出します。
- **EXT (IBM ACE 等)**: 拡張ルールセットによる静的解析。複雑なARIAの関係性やランドマーク構造、ステータスメッセージ（4.1.3）の判定に優れています。
- **DEEP (Puppeteer)**: 視覚・レンダリングの検証。ブラウザの描画結果に基づくリフロー（1.4.10）、テキスト間隔（1.4.12）、ターゲットサイズ（2.5.8）、および色だけの情報伝達（1.4.1）のうち本文リンク識別・ナビゲーション current/selected 表示など、視覚差分に依存する判定を担います。
- **PLAY (Playwright)**: キーボード操作とフォーカスの検証。実際のTabキートラバーサルやフォーカスの可視性（2.4.7）、非隠蔽（2.4.11）、キーボードトラップ（2.1.2）の判定に特化しています。
- **MULTI (AI / LLM・VLM)**: 文脈と視覚的意味の推論。代替テキストの妥当性（1.1.1）、リンクの目的（2.4.4）、エラー修正の提案（3.3.3）など、ツールでは判定不可能な「意味の理解」を補完します。BASIC/EXT/DEEP/PLAY の結果を参照してファクトチェックと改善提案（improvementPlan）を生成します。

## 評価の定義

- **◎ (確実)**: ツールによる機械的・決定論的なテストが可能で、誤検知・見落としが極めて少ない。
- **◯ (精度高)**: 高い確率で自動検出できるが、複雑な実装やエッジケースで見落とし・誤検知の可能性がある。
- **△ (精度中)**: 一部の実装パターンのみ検出可能、またはAIの推論等により一定のブレが含まれる。
- **▲ (精度低)**: 検出を試みるが参考程度であり、手動確認が前提となる。
- **- (確認不可)**: 該当スキャンエンジンでは技術的・原理的に検出できない。

## SC権威スキャン（SC_AUTHORITY）

特定のSCについては精度の高いスキャンが権威スキャンとして定義されており、他のスキャンの結果よりも優先されます。

| 権威スキャン | 対象SC |
|:---|:---|
| **PLAY** | 2.1.1 / 2.1.2 / 2.1.4 / 2.4.3 / 2.4.7 / 2.4.11 （キーボード操作・フォーカス系） |
| **EXT** | 1.3.1 / 1.3.5 / 4.1.2 / 4.1.3 （アクセシビリティ名・ロール・構造系） |
| **BATCH** | 3.2.3 / 3.2.4 （一括複数URLのナビゲーション横断比較。MULTIのaiTarget評価より優先） |

## MULTIスキャン対象項目（aiTarget）

MULTI は以下の18項目のみを直接評価します（自然言語・視覚的文脈の理解が必要な項目）。それ以外のSCに対しては、他スキャンの検出結果をAIプロンプトの文脈として渡し、ファクトチェックと改善提案に活用します。なお `1.4.1` は **DEEP が視覚的判定の主担当、MULTI が色語・凡例・必須/エラー表示など文脈依存の意味判定を補助**するハイブリッド運用です。

`1.1.1` `1.2.1` `1.2.2` `1.2.3` `1.2.5` `1.3.3` `1.4.1` `1.4.5` `2.4.4` `2.4.5` `3.2.3` `3.2.4` `3.2.6` `3.3.1` `3.3.3` `3.3.4` `3.3.7` `3.3.8`

## 適性一覧表 (WCAG 2.2 A / AA)

| SC | 達成基準名 | レベル | BASIC | EXT | DEEP | PLAY | MULTI |
|:---|:---|:---:|:---:|:---:|:---:|:---:|:---:|
| 1.1.1 | 非テキストコンテンツ | A | ◯ | ◯ | - | - | △ |
| 1.2.1 | 音声のみ・映像のみ（収録済） | A | ▲ | - | - | - | △ |
| 1.2.2 | キャプション（収録済） | A | ▲ | - | - | - | △ |
| 1.2.3 | 音声解説またはメディア代替（収録済） | A | ▲ | - | △ | - | △ |
| 1.2.4 | キャプション（ライブ） | AA | ▲ | - | - | - | - |
| 1.2.5 | 音声解説（収録済） | AA | ▲ | - | - | - | △ |
| 1.3.1 | 情報と関係性 | A | ◯ | ◎ | - | △ | - |
| 1.3.2 | 意味のある順序 | A | ▲ | - | △ | △ | - |
| 1.3.3 | 感覚的特徴 | A | - | - | △ | △ | ◯ |
| 1.3.4 | 表示の向き | AA | - | - | ◎ | - | - |
| 1.3.5 | 入力目的の特定 | AA | ◎ | ◎ | - | ◎ | - |
| 1.4.1 | 色の使用 | A | - | - | ◯ | - | △ |
| 1.4.2 | 音声の制御 | A | - | - | △ | - | - |
| 1.4.3 | コントラスト（最低限） | AA | ◎ | ◯ | △ | - | - |
| 1.4.4 | テキストのサイズ変更 | AA | ◯ | ◯ | ◯ | - | - |
| 1.4.5 | 文字画像 | AA | - | - | ▲ | - | ◯ |
| 1.4.10 | リフロー | AA | - | - | ◎ | - | - |
| 1.4.11 | 非テキストのコントラスト | AA | ▲ | - | - | - | - |
| 1.4.12 | テキストの間隔 | AA | - | - | ◎ | - | - |
| 1.4.13 | ホバー/フォーカスで表示されるコンテンツ | AA | - | - | △ | - | - |
| 2.1.1 | キーボード | A | ▲ | △ | - | ◎ | - |
| 2.1.2 | キーボードトラップなし | A | - | - | - | ◎ | - |
| 2.1.4 | 文字キーショートカット | A | - | △ | - | ◎ | - |
| 2.2.1 | タイミング調整 | A | - | - | - | - | - |
| 2.2.2 | 一時停止、停止、非表示 | A | - | - | △ | - | - |
| 2.3.1 | 3回の閃光、または閾値以下 | A | - | - | ◯ | - | - |
| 2.4.1 | ブロックスキップ | A | ◎ | ◎ | ◎ | - | - |
| 2.4.2 | ページタイトル | A | ◎ | ◎ | - | ◎ | - |
| 2.4.3 | フォーカス順序 | A | △ | - | - | ◎ | - |
| 2.4.4 | リンクの目的（コンテキスト内） | A | △ | △ | △ | - | ◯ |
| 2.4.5 | 複数の手段 | AA | - | - | - | - | △ |
| 2.4.6 | 見出しとラベル | AA | △ | ◯ | - | ◯ | - |
| 2.4.7 | フォーカスの可視性 | AA | - | - | △ | ◎ | - |
| 2.4.11 | フォーカスの非隠蔽（最低限） | AA | - | - | △ | ◎ | - |
| 2.4.13 | フォーカスの外観 | AA | - | - | △ | ◎ | - |
| 2.5.1 | ポインタジェスチャ | A | - | - | - | - | - |
| 2.5.2 | ポインタのキャンセル | A | - | - | - | - | - |
| 2.5.3 | 名前に含まれるラベル | A | △ | ◯ | △ | ◎ | - |
| 2.5.4 | モーション動作 | A | - | - | - | - | - |
| 2.5.7 | ドラッグ動作 | AA | - | - | - | - | - |
| 2.5.8 | ターゲットのサイズ（最低限） | AA | - | - | ◎ | - | - |
| 3.1.1 | ページの言語 | A | ◎ | ◎ | - | ◎ | - |
| 3.1.2 | 一部分の言語 | AA | ◎ | ◎ | - | - | - |
| 3.2.1 | フォーカス時 | A | - | - | △ | △ | - |
| 3.2.2 | 入力時 | A | - | - | △ | △ | - |
| 3.2.3 | 一貫したナビゲーション | AA | - | - | - | - | ◯ |
| 3.2.4 | 一貫した識別性 | AA | - | - | - | - | ◯ |
| 3.2.6 | 一貫したヘルプ | A | - | - | - | - | △ |
| 3.3.1 | エラーの特定 | A | - | - | - | - | ◯ |
| 3.3.2 | ラベルまたは説明 | A | ◎ | ◎ | - | ◎ | - |
| 3.3.3 | エラー修正の提案 | AA | - | - | - | - | ◯ |
| 3.3.4 | エラー回避（法的、金融、データ） | AA | - | - | - | - | ◯ |
| 3.3.7 | 冗長な入力 | A | - | - | - | - | △ |
| 3.3.8 | 認証（最低限） | AA | - | - | - | - | ◯ |
| 4.1.2 | 名前、役割、値 | A | ◎ | ◎ | - | ◯ | - |
| 4.1.3 | ステータスメッセージ | AA | ◯ | ◎ | - | ◯ | - |

> **補足**:
> - WCAG 2.2 にて削除・非推奨となった `4.1.1 構文解析` は一覧から除外しています。
> - AAA β モードを有効にすると `2.3.3`, `2.4.12` 等の AAA 基準が追加されます。`2.4.12`（フォーカスの非隠蔽・強化）は PLAY が権威スキャンです。`2.4.13`（フォーカスの外観）は WCAG 2.2 AA 基準のため通常対象に含まれます。
> - **MULTI の `-`**: MULTI が直接評価するのは上記 aiTarget の18項目のみです。それ以外のSCに表示される `-` は「直接評価しない」を意味しますが、BASIC/EXT/DEEP/PLAY の検出結果はすべて AI プロンプトの文脈として渡されるため、improvementPlan の改善提案には間接的に反映されます。
> - MULTI スキャンの精度は、利用するAIモデル（Gemini 2.5 Pro / GPT-4o / Claude Opus など）によって向上する可能性があります。
> - スキャン実行順序: BASIC → EXT → DEEP → PLAY → MULTI。PLAY結果は MULTI に事前送信され、キーボード系SCの重複評価を省略します。

## 実装ベース判定ロジック一覧（56 SC）

本節は、**2026-04-24 時点のコード実装そのもの**を基準に、スコア対象56 SCがどの scan / 補助ロジックで判定されるかを要約したものです。

- `BASIC` = `POST /api/check`。`axe-core` を WCAG タグ付きで実行
- `EXT` = `POST /api/ext-check`。IBM ACE + ネイティブDOM検査 + CDP
- `DEEP` = `POST /api/enhanced-check`。Puppeteer による描画・操作検査
- `PLAY` = `POST /api/playwright-check`。Playwright によるキーボード・AX検査
- `MULTI` = `getMultiVerificationMethodForAI()` に基づく AI 判定
- `AUTO_PASS` = `detectPageSignals()` と事前申告 `AUTO_PASS_SIGNAL_RULES` により「該当箇所なし」で自動合格

| SC | 達成基準名 | 実装ベース判定ロジック |
|:---|:---|:---|
| 1.1.1 | 非テキストコンテンツ | `BASIC` は `axe-core` の画像代替ルール群。`EXT` は IBM ACE の `WCAG20_Img_HasAlt`、`WCAG20_Object_HasText`、`WCAG20_Style_BackgroundImage` などを SC 1.1.1 に集約。`MULTI` は `imgAltList` とスクリーンショットを使い、`alt=""` の装飾画像は pass、ファイル名や汎用語 alt は fail、証拠不足は `manual_required`。 |
| 1.2.1 | 音声のみ・映像のみ（収録済） | `AUTO_PASS(noMedia)` 対応。`DEEP` は `check_1_2_x_media_captions()` で `audio` 近傍の transcript 文言、`video` の `track`、YouTube iframe の `cc_load_policy=1` を確認し、複合SC `1.2.1 / 1.2.2 / 1.2.4 / 1.2.5` として返す。`MULTI` は音声のみ・映像のみコンテンツに文字起こしやテキスト代替があるかを文脈で確認。 |
| 1.2.2 | キャプション（収録済） | `AUTO_PASS(noMedia)` 対応。`DEEP` の `check_1_2_x_media_captions()` が `video` の `track[kind="captions"/"subtitles"]` と字幕付き埋め込みの有無を確認。`MULTI` は字幕ボタン、字幕リンク、文字起こしなどの証拠を補助判定する。 |
| 1.2.3 | 音声解説またはメディア代替（収録済） | `AUTO_PASS(noMedia)` 対応。`DEEP` の `check_1_2_3_audio_description()` が `track[kind="descriptions"]`、`aria-describedby`、近接する「音声解説」「テキスト版」等の文言、装飾動画の `muted` を確認し、埋め込み動画は `unverified`、証拠なしは fail。`MULTI` は説明版や同等テキスト代替の存在を文脈評価する。 |
| 1.2.4 | キャプション（ライブ） | `AUTO_PASS(noMedia)` 対応。専用のライブ判定ロジックはなく、`DEEP` は `check_1_2_x_media_captions()` の複合判定を流用する。ライブ性の判定はコード上では持たず、該当メディアがある場合は他の証拠が薄ければ未検証寄りになる。 |
| 1.2.5 | 音声解説（収録済） | `AUTO_PASS(noMedia)` 対応。`DEEP` は `check_1_2_x_media_captions()` の複合判定を流用し、専用の 1.2.5 判定は持たない。厳密な音声解説の有無は `check_1_2_3_audio_description()` と `MULTI` の証拠確認に実質依存する。 |
| 1.3.1 | 情報と関係性 | `BASIC` は `axe-core` の構造系ルール。`EXT` は IBM ACE の `Input_ExplicitLabel`、`Fieldset_HasLegend`、`Table_Structure`、`List_UseMarkup` などを SC 1.3.1 に集約。`PLAY` は `pw_check_1_3_1_info_relationships()` でデータテーブルのヘッダー欠落と radio/checkbox グループの `fieldset` 欠落を確認。 |
| 1.3.2 | 意味のある順序 | `DEEP` と `PLAY` は共通の `check_1_3_2_meaningful_sequence()` を使い、`header/nav/footer/aside` を除く主要な本文・フォーム・表で、非ゼロの CSS `order` と単一カラム領域での大きな視覚的「上戻り」を順序ずれシグナルとして fail 判定する。`BASIC` / `EXT` / `MULTI` に専用ロジックはない。 |
| 1.3.3 | 感覚的特徴 | `EXT` は IBM ACE の `WCAG20_Text_Emoticons` を 1.3.3 に集約するが補助的。`DEEP` と `PLAY` は `check_1_3_3_sensory_characteristics()` で「右の」「赤い」「丸い」「音が鳴ったら」等の感覚依存らしい指示文候補を抽出し、候補があれば `manual_required`。`MULTI` が最終的に、ラベル名や見出し名が併記されているかまで文脈判断する。 |
| 1.3.4 | 表示の向き | `DEEP` の `check_1_3_4_orientation()` が `@media (orientation: ...)` 内の `display:none` / `visibility:hidden`、および `body` の `transform: rotate(...)` を検出し、方向固定の疑いを fail にする。 |
| 1.3.5 | 入力目的の特定 | `BASIC` は `axe-core` の `autocomplete` 系ルール。`EXT` は IBM ACE の `WCAG20_Input_Autocomplete` / `WCAG21_Input_Autocomplete`。`DEEP` は `check_1_3_5_input_purpose()` で `name / email / tel / postal-code` 等をヒントから推定し、期待される `autocomplete` を照合。`PLAY` は visible な `input / textarea / select` の `autocomplete` 欠落を幅広く fail にする。 |
| 1.4.1 | 色の使用 | `DEEP` の `check_1_4_1_use_of_color()` が主担当で、本文中インラインリンクとナビゲーション current/selected 状態について、通常時の下線、太さ差、サイズ差、枠線、背景塗り、色差 `3:1` を確認する。`MULTI` は「赤いボタン」「緑が完了」等の色語・凡例・必須/エラー表示の意味依存を補助判定し、`1.4.1` は `DEEP fail` または `MULTI fail` のどちらでも TOTAL fail になる。 |
| 1.4.2 | 音声の制御 | `AUTO_PASS(noMedia)` 対応。音声・動画が存在しない場合は合格扱い。メディアがある場合の専用自動判定ロジックはコード上にないため、実質 `未検証` のまま残る。 |
| 1.4.3 | コントラスト（最低限） | `BASIC` の `axe-core` によるコントラスト判定が主力（◎）。`EXT` は IBM ACE の `IBMA_Color_Contrast_WCAG2AA` ルールをSC 1.4.3 にマッピングし、ACEが検出した違反を集約する（◯）。`DEEP` は `check_1_4_3_text_contrast()` で可視テキスト最大150件をサンプリングし、前景色と解決済み背景色の輝度差から WCAG 閾値（通常テキスト 4.5:1、大きいテキスト ≥18pt/≥14pt bold で 3:1）を計算する。`aria-hidden="true"`、`hidden`、`inert`、および `screen-reader-text` / `sr-only` / `visually-hidden` 等のSR専用要素は対象外。ただし CSS 変数・グラデーション・`background-image` 上のテキストは正確に解決できないため参考値として扱い（△）、確定判定は BASIC axe-core を優先する。 |
| 1.4.4 | テキストのサイズ変更 | `BASIC` は `axe-core` タグ、`EXT` は IBM ACE の `WCAG21_Style_Viewport` を SC 1.4.4 にマッピング（◯）、`DEEP` は `check_1_4_4_text_resize()` で `html` の `font-size` を 200% にし、`overflow:hidden` によるクリップと横スクロールを検出する。 |
| 1.4.5 | 文字画像 | `DEEP` の `check_1_4_5_images_of_text()` が `canvas`、長い `img[alt]`、`background-image` を手掛かりに「文字画像の可能性」を抽出し `manual_required` を返す（▲）。画像内容を実際には読めないため確定 fail にはできず、手動確認のトリガーにとどまる。`MULTI` はスクリーンショットと画像リストから、ロゴ等の例外を除く本文・説明用の文字画像を文脈評価する（◯）。 |
| 1.4.10 | リフロー | `DEEP` の `check_1_4_10_reflow()` が viewport を `320x256` に縮め、`scrollWidth > 320` と右端にはみ出す要素を列挙して fail 判定する。 |
| 1.4.11 | 非テキストのコントラスト | `BASIC` の `axe-core` による `non-text-contrast` ルールのみ（▲）。コード上の専用 `DEEP` / `PLAY` / `EXT` ロジックはない。フォームのボーダー・アイコンボタン境界色など、axe-core が解析できない要素は見落とすリスクがある。 |
| 1.4.12 | テキストの間隔 | `DEEP` の `check_1_4_12_text_spacing()` が `line-height`, `letter-spacing`, `word-spacing`, `p margin-bottom` を強制注入し、`overflow:hidden` による text clipping を確認する。`sr-only` 系クラスは除外している。 |
| 1.4.13 | ホバー/フォーカスで表示されるコンテンツ | `DEEP` の `check_1_4_13_hover_content()` が tooltip/popover 候補要素にマウスを当て、表示されたホバーコンテンツが `Escape` で閉じるかを確認する。対象要素が無ければ `not_applicable`。 |
| 2.1.1 | キーボード | `PLAY` が権威。`pw_check_2_1_1_full_tab_sequence()` で最大60回 `Tab` し、到達可能要素数と hidden 要素混入を確認する。`DEEP` は `check_2_1_1_keyboard_operable()` で `onclick` や `cursor:pointer` を持つ非フォーカス要素を fail。`EXT` は `ext_check_2_1_1_scrollable()` でスクロール領域の `tabindex` 欠落を fail。 |
| 2.1.2 | キーボードトラップなし | `DEEP` と `PLAY` は共通の `detectKeyboardTrapsByTabbing()` を使用し、同一要素に `Tab` が3回続いた場合を候補とした上で `Shift+Tab → Tab → Tab` でも抜けられないときだけ fail。`aria-modal="true"` 内の正当なモーダルトラップは除外する。 |
| 2.1.4 | 文字キーショートカット | `PLAY` の `pw_check_2_1_4_character_shortcuts()` が `accesskey` 属性を fail。`EXT` の `ext_check_2_1_4_cdp_shortcuts()` は `accesskey` と CDP で拾った `keydown/keypress/keyup` リスナーを潜在ショートカットとして `unverified` にし、無効化・再割り当ての手動確認を促す。IBM ACE の `WCAG20_Elem_UniqueAccessKey` も 2.1.4 に集約される。 |
| 2.2.1 | タイミング調整 | `AUTO_PASS(noTimelimit)` 対応。`DEEP` の `check_2_2_1_timing_adjustable()` が `setTimeout` をフックし、20秒超のタイマーを fail。`EXT` は IBM ACE の `WCAG20_Meta_RedirectZero` を 2.2.1 に集約する。 |
| 2.2.2 | 一時停止・停止・非表示 | `AUTO_PASS(noMoving)` 対応。`DEEP` の `check_2_2_2_pause_stop()` が `video[autoplay]` の停止ボタン、`marquee`、5秒超の CSS animation を確認する。`EXT` も IBM ACE の `WCAG20_Blink_AlwaysTriggers` と `RPT_Marquee_Trigger` を 2.2.2 に集約する。 |
| 2.3.1 | 3回の閃光 | `AUTO_PASS(noMoving)` 対応。`DEEP` の `check_2_3_1_three_flashes()` が実際に使われている `@keyframes` から `opacity:0` や `visibility:hidden` を含む点滅候補を抽出し、自動再生 `video` も含めて fail とする。メッセージ上は手動確認推奨だが、スコア上は fail を返す。 |
| 2.4.1 | ブロックスキップ | `BASIC` は `axe-core` の skip-nav 系ルール。`EXT` の `ext_check_2_4_1_landmarks()` が `main`、`nav`、skip link の有無を確認。`DEEP` の `check_2_4_1_skip_link()` は最初の focusable 要素が skip link か、そのリンク先が存在するか、ランドマークがあるかを確認する。 |
| 2.4.2 | ページタイトル | `BASIC` は `axe-core`。`EXT` は IBM ACE の `WCAG20_Doc_HasTitle`。`PLAY` の `pw_check_2_4_2_page_title()` が空、短すぎる、`Untitled` 等の無意味タイトルを fail にする。 |
| 2.4.3 | フォーカス順序 | `PLAY` が権威。`pw_check_2_4_3_focus_order()` が `Tab` で辿った要素の座標と `tabindex > 0` を見て、視覚順からの大きな逸脱を fail にする。`DEEP` も同等の `check_2_4_3_focus_order()` を持つ。 |
| 2.4.4 | リンクの目的 | `BASIC` / `EXT` は link text 欠落や冗長な画像リンクテキストをルールベースで検出。`DEEP` の `check_2_4_4_link_purpose()` は「こちら」「read more」等の汎用リンク語と無テキストリンクを fail。`MULTI` はリンク文字列に加えて近接する見出し、段落、`aria-label`、`title` を見て目的が文脈から分かるかを評価する。 |
| 2.4.5 | 複数の手段 | `MULTI` 専用。検索、サイトマップ、グローバルナビ、パンくず、関連リンクなど、ページ到達手段の証拠を画面とHTMLから探す。単一ページだけではサイト全体判断が難しいため、証拠不足時は `manual_required`。 |
| 2.4.6 | 見出しとラベル | `BASIC` は `axe-core`。`EXT` は IBM ACE の `WCAG20_Input_VisibleLabel` とネイティブ `ext_check_2_4_6_heading_order()` により見出しスキップ、`h1` 欠落・複数を検出。`PLAY` は空の見出しタグと unlabeled form control を fail にする。 |
| 2.4.7 | フォーカスの可視性 | `PLAY` が権威。`pw_check_2_4_7_focus_visible_all()` が focus 後の outline、box-shadow、border の存在を確認。`DEEP` の `check_2_4_7_focus_visible()` も focus 前後の style 差分から indicator を確認し、AA と AAA の結果を分けて返す。 |
| 2.4.11 | フォーカスの非隠蔽（最低限） | `PLAY` が権威。`pw_check_2_4_11_focus_obscured()` と `DEEP` の `check_2_4_11_12_focus_obscured()` が、focus 時にも非表示の要素と、fixed/sticky 要素に90%以上覆われる要素を fail とする。 |
| 2.4.13 | フォーカスの外観 | WCAG 2.2 新規 AA 基準。フォーカスインジケータの面積・コントラスト要件。`PLAY` の `pw_check_2_4_7_focus_visible_all()` が focus indicator の存在を確認（2.4.7 と共通実装）。`DEEP` の `check_2_4_7_focus_visible()` が focus 前後の style 差分から確認する。専用の面積・コントラスト判定ロジックは未実装のため、現状は `unverified` に残る。 |
| 2.5.1 | ポインタジェスチャ | `AUTO_PASS(noGesture)` 対応。`DEEP` の `check_2_5_1_7_gestures()` が `draggable="true"` 要素に代替ボタンがあるか、`swiper` 等のスワイプ UI に next/prev 相当ボタンがあるかを見て fail。`2.5.7` と共通実装。 |
| 2.5.2 | ポインタのキャンセル | `AUTO_PASS(noGesture)` 対応。`DEEP` の `check_2_5_2_pointer_cancellation()` が `onmousedown` で `location` / `submit` / `href` / `window.open` を直接呼ぶ要素を fail にする。 |
| 2.5.3 | 名前に含まれるラベル | `EXT` は IBM ACE の `Rpt_Aria_OrphanedContent_Native_Host_Sematics` 等（◯）。`DEEP` は Section A の `check_2_5_3_label_in_name()` で visible text と `aria-label` の不一致を検出（△）。`PLAY` は `pw_check_2_5_3_label_in_name()` で同様の確認を Playwright ベースで行う（◎）。 |
| 2.5.4 | モーション動作 | `AUTO_PASS(noGesture)` 対応。`DEEP` の `check_2_5_4_motion_actuation()` が `devicemotion` / `deviceorientation` リスナーの使用をフックし、代替ボタンがあれば `manual_required`、無ければ fail。 |
| 2.5.7 | ドラッグ動作 | `AUTO_PASS(noGesture)` 対応。`DEEP` の `check_2_5_1_7_gestures()` を `2.5.1` と共有し、`draggable` 要素とスワイプ UI の代替ボタン有無で判定する。 |
| 2.5.8 | ターゲットのサイズ（最低限） | `DEEP` の `check_2_5_8_target_size()` が `a/button/input/select/textarea/role=*` を対象に 24x24px 未満を fail とする。`sr-only` 系要素と、本文中インラインテキストリンクは除外している。 |
| 3.1.1 | ページの言語 | `BASIC` は `axe-core`。`EXT` は IBM ACE の `WCAG20_Html_HasLang` / `WCAG20_Html_Lang_Valid`。`PLAY` の `pw_check_3_1_1_language()` が `html lang` の有無と形式を fail にする。 |
| 3.1.2 | 一部分の言語 | `AUTO_PASS(noPartialLanguage)` 対応。`BASIC` は `axe-core` の SC tag ベース、`EXT` は IBM ACE の `WCAG20_Elem_Lang_Valid` を使用する。ページ内に部分的な他言語記述がないと宣言・検出された場合は合格扱い。 |
| 3.2.1 | フォーカス時 | `DEEP` の `check_3_2_1_2_unexpected_change()` が `MutationObserver`、`window.open` フック、`form.submit` フック、URL 変化監視を使い、`Tab` 移動中にコンテキスト変化が起きると fail。実装は `3.2.1/3.2.2` の複合結果を返し、スコア側で両SCに配賦する。 |
| 3.2.2 | 入力時 | `DEEP` は `check_3_2_1_2_unexpected_change()` で `select` の change 後の DOM 変化、`window.open`、URL 変化を監視。`EXT` は IBM ACE の `WCAG20_Input_HasOnchange` と `WCAG20_Select_NoChangeAction` を 3.2.2 に集約する。 |
| 3.2.3 | 一貫したナビゲーション | `BATCH` が権威。`/api/batch-check` で URL ごとの `navStructure` を抽出し、nav 要素数、リンク集合、リンク順序を比較して `navConsistency` を生成する。`MULTI` は複数ページ比較があるときだけ補助判定し、単一ページでは原則 `manual_required`。 |
| 3.2.4 | 一貫した識別性 | `BATCH` が権威。`navStructure` 比較でリンクテキスト差分や順序差分を拾い、同一機能の名称不一致の強いシグナルとして利用する。`MULTI` は繰り返し要素の名称・ラベル・アイコンの一貫性を補助判定する。 |
| 3.2.6 | 一貫したヘルプ | `DEEP` の `check_3_2_6_consistent_help()` が `header` / `footer` / `nav` の中に `help/support/faq/contact/tel/mailto` を探し、見つからなければ fail、header/footer 自体が無ければ `manual_required`。`MULTI` は複数ページ比較があれば位置の一貫性を評価する。 |
| 3.3.1 | エラーの特定 | `AUTO_PASS(noForm)` 対応。`DEEP` の `check_3_3_1_error_identification()` が全フォームを空送信し、`aria-invalid`、`role="alert"`、`error` 系クラス、`aria-describedby` / `aria-errormessage` の関連付けを確認する。`MULTI` は可視エラー、関連付け、フォーム文脈を補助評価する。 |
| 3.3.2 | ラベルまたは説明 | `BASIC` は `axe-core`、`EXT` は IBM ACE の `WCAG22_Label_Tooltip_Required`、`PLAY` の `pw_check_3_3_2_labels()` は visible な `input / textarea / select` について `label`、`aria-label`、`aria-labelledby`、`title`、`placeholder`、`aria-describedby`、label wrapping のいずれも無いものを fail にする。さらに `required` / `aria-required="true"` の入力欄は、ラベル・近接するフィールド領域・説明文・placeholder/title・フォーム全体説明のいずれかに「必須」等の表示が無い場合も fail にする。 |
| 3.3.3 | エラー修正の提案 | `AUTO_PASS(noForm)` 対応。`DEEP` の `check_3_3_3_error_suggestion()` が空送信後のエラー文言を見て、「入力」「選択」「確認」などの具体的修正指示を含むかを判定し、エラーが出なければ `manual_required`。`MULTI` は例示や許容形式まで含めて文脈評価する。 |
| 3.3.4 | エラー回避（法的・金融・データ） | `AUTO_PASS(noForm)` 対応。コード上の直接自動判定は `MULTI` のみで、法律・金融・データ変更・試験等の重要送信フォームかを文脈で見た上で、取消、確認、修正、undo などの証拠を探す。単一ページで送信フローが見えなければ `manual_required`。 |
| 3.3.7 | 冗長な入力 | `AUTO_PASS(noForm)` 対応。`DEEP` の `check_3_3_7_redundant_entry()` が multi-step UI、複数フォーム間の自由入力系同名フィールド、multi-step 下での `autocomplete` 欠落を確認候補として検出する。checkbox/radio の同一 `name`、`name[]` の配列フィールド、同一フォーム内の選択肢グループは冗長入力扱いしない。DEEP単体では自動不合格にせず `manual_required` にとどめ、`MULTI` は実際の再入力強要かどうかを文脈で補助判定する。 |
| 3.3.8 | 認証（最低限） | `AUTO_PASS(noAuth)` 対応。`DEEP` の `check_3_3_8_accessible_authentication()` が password、OTP、passkey ボタン、認証 form を検出し、認証 UI が無ければ `not_applicable`、password 型なら `autocomplete` と CAPTCHA の有無を確認、OTP/passkey 型は `manual_required`。`MULTI` は認知機能テストや代替手段の有無を文脈評価する。 |
| 4.1.2 | 名前、役割、値 | `BASIC` は `axe-core` の name/role/value ルール。`EXT` は IBM ACE の `Rpt_Aria_ValidRole`、`Rpt_Aria_RequiredProperties`、`Rpt_Aria_ValidPropertyValue`。`PLAY` の `pw_check_4_1_2_accessible_names()` がインタラクティブ要素のアクセシブルネーム欠落を fail。`DEEP` の `check_aria_attributes()` は toggle 候補に `aria-expanded` が無い場合を fail とし、同SCに集約する。 |
| 4.1.3 | ステータスメッセージ | `BASIC` は `axe-core` の status message ルール。`PLAY` の `pw_check_4_1_3_status_messages()` が `aria-live` / `role="status"` / `role="alert"` と、live region 外にある動的クラス要素を比較する。`DEEP` の `check_aria_attributes()` は form や動的通知クラスがあるのに `aria-live` / `role="alert"` 系リージョンが見当たらない場合を `manual_required` にする。 |

### 実装上の注意

- `manualCheckItems` は UI 上 48 件ですが、スコア母数は `WCAG_SC` の **56 SC** を使用しています。
- `3.2.3 / 3.2.4` は単一ページでは確定しにくいため、**一括検査の `navConsistency` が最優先**です。
- `1.4.2`、`2.4.5` など一部SCは、コード上 **AUTO_PASS 以外の専用自動ロジックがまだ薄く**、該当箇所があるページでは `未検証` に残りやすい実装です。

---

## 総合精度評価 (2026-04-28 時点)

### スキャンエンジン別 精度サマリー

| エンジン | 担当SC数 (主担当) | 検出精度 | 誤検出リスク | 見落としリスク | 総合評価 |
|:---|:---:|:---:|:---:|:---:|:---:|
| **BASIC** (axe-core) | ~15 SC | ◎ | 低〜中 | 中 | **B+** |
| **EXT** (IBM ACE) | ~12 SC | ◎ | 低 | 中 | **A−** |
| **DEEP** (Puppeteer) | ~22 SC | ◯ | 中〜高 | 低〜中 | **B** |
| **PLAY** (Playwright) | ~14 SC | ◎ | 低 | 低〜中 | **A−** |
| **MULTI** (AI/LLM) | 18 SC (aiTarget) | △〜◯ | 中〜高 | 中 | **C+** |
| **BATCH** | 2 SC (3.2.3/3.2.4) | ◯ | 低 | 中 | **B+** |

> **評価基準**: A=95%以上の精度・低誤検出 / B=80〜94% / C=60〜79% / D=60%未満  
> 「担当SC数」はその engine が `pass/fail` を返す主担当SCの概算。

---

### スキャン別 誤検出リスク一覧

#### BASIC (axe-core)

| SC | リスク | 説明 |
|:---|:---|:---|
| 1.1.1 | 中 | `alt=""` が適切な装飾画像に対し、コンテキスト（リンク内の唯一の img 等）によっては誤 fail になる場合がある |
| 1.4.3 | 低〜中 | CSS変数・グラデーション・画像背景のテキストはコントラスト計算が不正確になり得る。`background-image` 上のテキストは incalculable 扱いで未検証になるため見落とし側にバイアス |
| 2.4.4 | 中 | アイコンフォント + `aria-label` のリンクや、`aria-describedby` で補足されたリンクを empty label として誤 fail する |
| 4.1.2 | 低〜中 | `aria-expanded` 欠落でトグルボタンを fail にするが、`aria-pressed` 実装のトグルは合格すべき代替パターンであり誤検出になる |

#### EXT (IBM ACE)

| SC | リスク | 説明 |
|:---|:---|:---|
| 1.3.1 | 低 | 独自フレームワーク（Vue/React ShadowDOM）の label 関連付けを未解決とみなし誤 fail になることがある |
| 4.1.2 | 低 | 独自 ARIA role（`role="combobox"` の v1/v2 差分など）でルールが古い場合に誤 fail |
| 2.1.4 | 中 | CDP で拾った `keydown` リスナー全体を潜在ショートカットとして `unverified` にするため、内部ロジックのみで UI 操作に関係しないハンドラも混入する |

#### DEEP (Puppeteer)

| SC | リスク | 説明 |
|:---|:---|:---|
| 2.5.8 | **高** | インラインテキストリンクは除外しているが、`display:inline` の小さなバッジ・タグ要素や装飾的スパンを誤 fail にしやすい。`406×16px` のような横長スリム要素も誤検出される事例あり |
| 3.2.1 / 3.2.2 | 中 | `Tab` 移動中の `MutationObserver` が、意図的なアニメーション（ドロワーの開閉等）や `aria-live` による非同期更新を「コンテキスト変化」として誤 fail にすることがある |
| 4.1.2 | 中〜高 | `aria-expanded` 欠落判定が `aria-pressed` 実装のスライドショー停止ボタン等に適用され誤 fail になる。WCAG 上は `aria-pressed` も有効な実装であるため除外が必要 |
| 2.4.3 | 中 | 座標ベースの focus 順序判定は、故意に非線形配置されたカルーセルや2カラムレイアウトで誤 fail になる |
| 1.4.1 | 中 | ナビゲーションの current/selected 判定で、背景色・枠線ではなくテキスト色のみで区別する実装を見落とすことがある。一方 CSS 差分が小さいデザインを誤 fail にするケースもある |
| 2.4.4 | 中 | 「こちら」「詳細はこちら」等を汎用リンクとして fail にするが、`aria-label` や近接見出しで目的が補完されている場合でも誤 fail になる |
| 2.4.1 | 低〜中 | skip link が `display:none` → focus で表示される実装の場合、Puppeteer の headless モードで focus イベントが正しく発火しないことがある |

#### PLAY (Playwright)

| SC | リスク | 説明 |
|:---|:---|:---|
| 2.4.7 | 中 | focus indicator の検出は outline / box-shadow / border の CSS 差分に依存するため、JS による class 切り替えや SVG focus 表示を見落とす |
| 2.1.1 | 低〜中 | 最大 60 回の Tab のみで判定するため、Tab 到達可能でも実際には機能しないカスタムコンポーネントの問題を見落とす |
| 3.3.2 | 中 | `placeholder` を label 代替として検出しているが、WCAG 上 placeholder 単独はラベルの代替として不十分であるため、ここを合格と判定しているのは緩すぎる可能性がある。必須表示は DOM と CSS 疑似要素から確認するため、画像だけで示した必須マークは手動確認が必要 |
| 4.1.3 | 中 | `aria-live` リージョン外の動的更新クラスを find するが、実際にアナウンスが行われるかブラウザの AT 実装まで追うことができない |

#### MULTI (AI/LLM)

| SC | リスク | 説明 |
|:---|:---|:---|
| 1.1.1 | **高** | スクリーンショットの解像度・切り抜き範囲・モデルのバイアスにより、適切な `alt` を「不足」、空 `alt` の装飾画像を「問題あり」と誤判定しやすい |
| 2.4.4 | 中〜高 | ページ全体のリンクリストから「目的が分からないリンク」を判定するが、近接する見出し文脈がプロンプトに十分含まれない場合に誤 fail |
| 3.3.1 / 3.3.3 | 中 | フォームのエラー表示はスクリーンショット取得タイミング次第で見えておらず、証拠不足で `manual_required` にされやすい |
| 3.2.3 / 3.2.4 | 中 | 単一ページの HTML のみから「一貫したナビゲーション」を判断するため、複数ページ比較なしでは信頼性が低い。BATCH 結果を渡すことで改善可能 |
| 全般 | 中 | トークン削減のため `shortHtml` を 8000 文字に制限しているため、ページ後半のコンテンツが評価対象から漏れる可能性がある |

---

### 見落とし（偽陰性）リスクの高いSC

| SC | 見落としリスク | 主要因 |
|:---|:---|:---|
| 1.2.4 | 高 | ライブメディアの専用判定ロジック未実装。`AUTO_PASS(noMedia)` が通れば合格扱いになる |
| 1.4.2 | 高 | 音声制御の専用自動ロジック未実装。メディアがあっても `未検証` のまま残りやすい |
| 2.4.5 | 高 | MULTI 単独依存。単一ページ文脈では証拠が薄く `manual_required` になりやすい |
| 2.5.1 / 2.5.2 | 中〜高 | `AUTO_PASS(noGesture)` が通れば合格。ジェスチャ依存 UI でも宣言がなければ見落とす |
| 1.4.11 | 中〜高 | axe-core の `non-text-contrast` のみ。フォームのボーダー、アイコンボタンの境界色のコントラスト不足を見落としやすい |
| 2.4.13 | 高 | focus indicator の面積・コントラスト比の専用計算ロジック未実装。存在確認のみで基準値チェックがない |
| 3.2.6 | 中 | `header/footer` 内のヘルプリンク文言マッチ依存。独自のカスタム問い合わせ UI や電話番号アイコンボタンは見落とす |
| 3.3.4 | 中 | MULTI 依存かつフォーム送信フローが見えない状態では `manual_required` 止まり |

---

### 既知の誤検出パターン（要対策）

以下は実際の検査運用で繰り返し発生している誤検出パターンです。

1. **スライドショー停止ボタン（`aria-pressed`）に `aria-expanded` 欠落 fail が出る**  
   対象: DEEP `check_aria_attributes()` / BASIC axe-core の `aria-required-attr`  
   原因: `aria-pressed` はトグルボタンの正規実装だが、`aria-expanded` 欠落として検出される  
   対策: `aria-pressed` を持つ要素を `aria-expanded` 未実装チェックから除外する

2. **ナビゲーションの全リンクに `aria-current="page"` 未設定の誤検出**  
   対象: PLAY `pw_check_2_4_4_link_purpose()` 等の aria-current チェック  
   原因: HOME ページでは現在ページリンクが存在しない設計が正規  
   対策: 現在 URL とナビゲーションのリンク URL を比較し、現在ページが nav に含まれない場合はスキップ

3. **`406×16px` 等の横長スリム要素が 2.5.8 ターゲットサイズ fail になる**  
   対象: DEEP `check_2_5_8_target_size()`  
   原因: WCAG 2.5.8 はインラインテキストリンクを除外しているが、インライン以外の装飾的なラベル要素も対象になっている  
   対策: `display:block/flex/grid` でもテキストコンテンツのみを含む非インタラクティブ要素を除外ルールに追加

4. **`HOME` ページでナビゲーションの `aria-current` が23件未設定と報告される**  
   対象: PLAY のナビゲーション検査  
   原因: HOME は全ページからアクセスされるため、ナビ内に「現在ページ」を示すリンクが存在しないケースが正規  
   対策: 現在 URL がナビゲーション内リンクのいずれとも一致しない場合は `not_applicable` に変更

---

### 総合精度評価

**ツール全体として WCAG 2.2 A/AA 56 SC のうち:**

- **機械的に高精度で検出可能 (◎)**: 約 20 SC（1.3.1, 1.3.5, 1.4.3, 2.4.1, 2.4.2, 3.1.1, 3.1.2, 4.1.2 等の構造・属性系）
- **一定精度で検出可能 (◯)**: 約 16 SC（キーボード操作・フォーカス系・コントラスト等）
- **補助的・要手動確認 (△/▲)**: 約 13 SC（音声・映像・意味判断が必要な項目）
- **実質手動のみ / 未実装 (-)**: 約 7 SC（ライブキャプション、ポインタジェスチャの細部、面積コントラスト等）

**偽陽性率の推定**: DEEP の視覚判定系 SC（2.5.8, 3.2.1, 4.1.2）で 10〜25% の誤検出が発生し得る。MULTI は文脈次第で 15〜30% の誤判定リスクがある。BASIC/EXT/PLAY の構造系は 5% 未満。

**偽陰性率の推定**: 1.2.4, 1.4.2, 2.4.5, 2.4.13, 1.4.11 等の一部SCは実質的な検出率が 20% 未満。AUTO_PASS シグナルが通れば問題があっても合格になる構造的リスクがある。

**推奨対応優先度**:
1. `aria-pressed` トグルの誤検出除外（DEEP・BASIC）— 影響範囲大、修正容易
2. 2.5.8 のインライン/装飾要素除外強化（DEEP）— 高頻度誤検出
3. `aria-current` ナビ検出の HOME ページ除外（PLAY）— 繰り返し発生
4. 2.4.13 focus indicator の面積・コントラスト計算ロジック追加（PLAY/DEEP）— 見落としリスク高
5. 1.4.2 音声制御の専用ロジック追加（DEEP）— 現状実質未検証
