# TEST_DEPLOY

Gitオートデプロイ確認項目。  
注記: 実行中の監視は不要。完了後のみ確認する。

## T-DEP-01: push後にworkflowが成功する

- 手順
  1. `main` へ push
  2. `Deploy to VPS` 実行結果を確認（完了後）
- 期待結果
  - `completed / success`
  - 実行SHAがpushしたSHAと一致

## T-DEP-02: VPS反映SHA確認

- 手順
  1. `cd /var/www/inspector`
  2. `git log -1 --oneline`
- 期待結果
  - `origin/main` と同一SHA

## T-DEP-03: PM2再起動確認

- 手順
  1. `pm2 status`
- 期待結果
  - `inspector-axe` が `online`
  - `errored` ではない

## T-DEP-04: ポート競合なし

- 手順
  1. `pm2 logs inspector-axe --lines 80 --nostream`
  2. `ss -lntp | grep -E ':3000|:3100'`
- 期待結果
  - `EADDRINUSE` がない
