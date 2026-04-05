# TEST_OUTPUT

スプシ出力（`/api/export-report`）実行後の確認項目。

## T-OUT-01: export-report API応答

- 手順
  1. `POST /axe/api/export-report` with `pages[]`
- 期待結果
  - `success: true`
  - `spreadsheetId` と `url` を返す

## T-OUT-02: シート構成

- 手順
  1. 返却 `url` のスプレッドシートを開く
- 期待結果
  - 表紙シートが作成される
  - URLごとにページシートが作成される

## T-OUT-03: 11列ヘッダー

- 手順
  1. 任意のページシートを確認
- 期待結果
  - 以下11列が存在
    - `No`, `検査種別`, `SC`, `検査項目`, `適合レベル`, `結果`, `場所`, `検出数`, `重要度`, `詳細`, `改善案`

## T-OUT-04: 行データ整合

- 手順
  1. BASIC/DEEP/MULTI を含む検査結果を出力
- 期待結果
  - `検査種別` が `自動/AI/手動/高精度/一括` のいずれか
  - `結果` 列が `合格/不合格/該当なし/未検証/判定不能` のいずれか

## T-OUT-05: sheets-status API

- 手順
  1. `GET /axe/api/sheets-status`
- 期待結果
  - `configured`, `geminiConfigured`, `aaaBeta` 等を返す
