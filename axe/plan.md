# WCAG検査精度向上プラン — Puppeteerベース高精度自動化
 
## Context
現在のツールはaxe-core自動検査（~35基準/高精度）+ Gemini AIスクリーンショット分析（~55基準/中〜低精度）で構成。
約50基準がAI推測または「検証不可」。Puppeteerの未活用能力（キーボード操作、ビューポート変更、CSS注入、イベント監視、CDP）を使って高精度自動検査に引き上げる。
 
## 現行アーキテクチャ
- `server.js`: Express + Puppeteer + axe-core + Gemini AI
- Puppeteerは現在「ページ読み込み→axe実行→スクショ撮影」のみ
- **未活用**: keyboard操作, setViewport, addStyleTag, evaluate, emulateMediaFeatures, CDP Session, accessibility.snapshot
 
---
 
## Phase 1: 完全自動化・高精度（期待精度90-95%）
 
### 1-1. SC 1.4.10 リフロー320px
```
page.setViewport({width:320, height:256})
→ document.documentElement.scrollWidth > 320 なら不合格
→ はみ出し要素リストを報告
```
 
### 1-2. SC 2.5.8 ターゲットサイズ24x24px
```
全clickable要素の getBoundingClientRect()
→ width < 24 || height < 24 を検出
→ インラインリンクは除外
※ axe-core の target-size ルールも併用
```
 
### 1-3. SC 2.1.2 キーボードトラップなし
```
Tab を N回（focusable要素数+20）連打
→ document.activeElement を毎回記録
→ 同一要素に3回以上連続停止 = トラップ検出
→ Shift+Tab の逆方向も検証
→ dialog[aria-modal] 内はトラップではなく正常
```
 
### 1-4. SC 2.4.1 スキップリンク
```
最初のfocusable要素が a[href^="#"] で "skip"/"main" 含むか
→ リンク先要素が実在するか
→ <main>, [role="main"], <nav> 等のランドマーク有無も確認
```
 
### 1-5. SC 2.3.3 アニメーション無効化
```
page.emulateMediaFeatures([{name:'prefers-reduced-motion', value:'reduce'}])
→ document.getAnimations().length を確認
→ CSSアニメーション残存を検出
→ @media(prefers-reduced-motion:reduce) ルールの有無をstyleSheets走査
```
 
### 1-6. SC 1.4.12 テキスト間隔調整
```
page.addStyleTag({content: '* { line-height:1.5em!important; letter-spacing:0.12em!important; word-spacing:0.16em!important; } p { margin-bottom:2em!important; }'})
→ overflow:hidden でテキストクリップされる要素を検出
→ innerText 比較でコンテンツ消失チェック
→ axe-core 再実行で新違反検出
```
 
### 1-7. SC 2.4.11/12 フォーカス隠れなし
```
Tab巡回で各要素のフォーカス時に getBoundingClientRect()
→ document.elementsFromPoint(centerX, centerY)
→ position:fixed/sticky の要素（ヘッダー、cookie banner）との重複検出
→ SC 2.4.11: 完全に隠れたら不合格
→ SC 2.4.12: 一部でも隠れたら不合格
```
 
### 1-8. SC 3.2.1/3.2.2 フォーカス/入力時の予期しない変化
```
MutationObserver + window.open フック注入
→ Tab移動ごとにURL変化・大規模DOM変更・新ウィンドウを監視
→ input/select への値入力後にコンテキスト変化を検出
→ 自動submit発火を検出
```
 
### 1-9. SC 3.3.1 エラー特定
```
form の required/aria-required フィールドを空で submit
→ aria-invalid="true", role="alert", .error クラス出現を検出
→ エラーとフィールドの関連付け (aria-describedby, aria-errormessage) を検証
→ axe-core 再実行（エラー状態）
```
 
---
 
## Phase 2: 高自動化・中〜高精度（期待精度80-90%）
 
### 2-1. SC 2.1.1 キーボード操作可能
```
page.accessibility.snapshot() で全interactive要素を取得
→ 各要素に element.focus() → document.activeElement 一致確認
→ Enter/Space で click イベント発火確認
→ onclick + cursor:pointer だが tabindex なし = 不合格
```
 
### 2-2. SC 2.4.7 フォーカス可視
```
Tab移動のたびに getComputedStyle() で outline/border/box-shadow/background-color 取得
→ フォーカス前後で変化なし = 不合格
→ バックアップ: element.screenshot() の前後ピクセル差分（pixelmatch）
→ SC 2.4.13: outline-width が 2px 以上かも検証
```
 
### 2-3. SC 2.4.3 フォーカス順序
```
Tab巡回で各要素の (x,y) 座標を記録
→ 視覚的読み順（上→下、左→右）との一致度を検証
→ tabindex > 0 は自動フラグ
```
 
### 2-4. SC 1.4.4 テキスト200%拡大
```
document.documentElement.style.fontSize = '200%'
→ scrollWidth > clientWidth かつ overflow:hidden でクリップされるテキスト検出
→ テキスト要素の重なり検出（getBoundingClientRect比較）
→ axe-core 再実行
```
 
### 2-5. SC 1.2.1-1.2.5 メディアキャプション
```
video/audio/iframe 検出
→ <track kind="captions">, <track kind="descriptions"> の有無
→ track ファイルが404でないか fetch() で確認
→ YouTube iframe: cc_load_policy パラメータ確認
→ audio: 近接要素に "transcript" テキストの有無
```
 
### 2-6. SC 2.2.2 動くコンテンツ停止
```
CDP Animation.enable でアニメーション検出
→ video[autoplay], .gif 画像, marquee 検出
→ 同コンテナ内に pause/stop ボタンの有無確認
```
 
### 2-7. SC 3.3.8 認証アクセシブル
```
input[type="password"] に autocomplete="current-password" があるか
→ paste イベントがブロックされていないか
→ CAPTCHA iframe (reCAPTCHA, hCaptcha) 検出 → 音声代替の有無
```
 
### 2-8. SC 3.2.3/3.2.4 一貫したナビ/識別（複数URL比較）
```
バッチ検査時に各ページの nav 構造をハッシュ比較
→ リンクテキスト・順序の差異を検出
→ 同機能コンポーネントの aria-label 一致度確認
```
 
### 2-9. SC 2.3.1 3回点滅
```
CDP Animation + @keyframes 解析で急速な色/透明度変化を検出
→ バックアップ: 3秒間スクリーンショット連続撮影（10fps）で輝度変化を計測
→ 1秒間に3回以上の明暗反転 = 不合格
```
 
---
 
## Phase 3: ハイブリッド（Puppeteer + AI補助、期待精度65-80%）
 
### 3-1. SC 1.4.13 ホバーコンテンツ
```
Puppeteer: page.hover(element) でコンテンツ出現検出
→ Escape で消えるか / マウス移動で持続するか検証
AI補助: 非自明なhoverトリガーの発見
```
 
### 3-2. SC 1.4.1 色だけの情報伝達
```
Puppeteer: リンクの色と周囲テキストの色差 + 下線/太字等の有無
AI補助: チャート/グラフ内の色使用判定
```
 
### 3-3. SC 1.4.5 文字画像
```
Puppeteer: img/svg/canvas/background-image の検出
AI補助: Gemini Vision でテキスト含有画像を判定
```
 
### 3-4. SC 2.2.1 制限時間調整
```
Puppeteer: setTimeout/setInterval をモンキーパッチで検出
AI補助: タイマーの目的（セッション制限 vs アニメーション）判定
```
 
### 3-5. SC 3.3.3 エラー修正提案
```
Puppeteer: フォーム空送信でエラーメッセージ抽出
AI補助: エラーメッセージが具体的な修正指示を含むか判定
```
 
### 3-6. SC 2.5.1/2.5.7 ジェスチャ/ドラッグ代替
```
Puppeteer: touchstart/dragstart/draggable 検出
AI補助: 代替UI（ボタン等）の有無判定
```
 
---
 
## 共通パターン: Before/After axe-core 差分
 
多くの検査で再利用するパターン:
```
1. axe.run(page) → ベースライン違反を記録
2. Puppeteer操作（viewport変更/CSS注入/エラー状態化）
3. axe.run(page) → 操作後の違反を記録
4. diff: 新しい違反 = 操作起因の問題
```
適用: SC 1.4.4, 1.4.10, 1.4.12, 3.3.1
 
## 精度向上サマリー
 
| カテゴリ | 現在 | Phase 1後 | Phase 2後 | Phase 3後 |
|----------|------|-----------|-----------|-----------|
| キーボード | 0% | 90-95% | 85-95% | — |
| ビジュアル/レスポンシブ | 30-40% | 90-95% | 85-90% | 65-80% |
| 時間・アニメーション | 0% | 90% | 80% | 60% |
| フォーム・エラー | 0% | 80% | 80% | 65% |
| ポインタ/タッチ | 30% | 95% | — | 65-70% |
| メディア | 0% | — | 80-85% | — |
| ナビゲーション | 60% | 95% | 80-90% | — |
 
## 修正対象ファイル
- `inspector/axe/server.js` — 新エンドポイント `POST /api/enhanced-check` + 各カテゴリの検査関数
- `inspector/axe/public/index.html` — enhanced-check 呼び出しUI + 結果表示
 
## 検証方法
1. 既知のアクセシビリティ問題を持つテストページ（例: https://www.w3.org/WAI/demos/bad/）で実行
2. 各基準の合格/不合格が正しいか手動確認
3. 既存axe-core結果との整合性確認
4. false positive / false negative 率の計測
