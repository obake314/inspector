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

## T-DEP-05: npm ci --omit=dev 確認

- 手順
  1. `ls /var/www/inspector/axe/node_modules | wc -l`
  2. `cat /var/www/inspector/axe/package.json` で devDependencies 確認
- 期待結果
  - devDependencies に含まれるパッケージが node_modules に存在しない
  - `npm ci --omit=dev` が正常実行された（ログに `added N packages` 表示）

## T-DEP-06: LAST UPDATED 更新確認

- 手順
  1. push 後に `https://inspector.eclo.info/axe/` を開く
  2. ページ内の `LAST UPDATED` 表示を確認
- 期待結果
  - デプロイ実行時刻が反映されている（古い日時でない）

## T-DEP-07: server.timeout 設定確認

- 手順
  1. `pm2 logs inspector-axe --lines 20 --nostream` で起動ログ確認
  2. または `curl -s https://inspector.eclo.info/axe/api/auth-status` で応答確認
- 期待結果
  - プロセスが正常起動している
  - `server.timeout = 600000`（10分）が設定された状態で動作
  - 2分以内に応答が返る通常リクエストは従来通り動作する

## T-DEP-08: Nginx proxy_read_timeout 確認

- 手順
  1. `grep -r proxy_read_timeout /etc/nginx/sites-enabled/ /etc/nginx/conf.d/`
- 期待結果
  - `proxy_read_timeout` が **600s 以上**（server.timeout=600000 と整合）
  - 未設定の場合はデフォルト 60s であり DEEP SCAN で途切れる可能性あり → 要設定
