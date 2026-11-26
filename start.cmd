@echo off
rem Cursor Run: ゲームサーバーと Cloudflare Tunnel をまとめて起動する（自分の PC から一時的に外へ出す用）
rem 前提: このフォルダで npm install 済み。cloudflared.exe が PATH にあるか、このフォルダに置いてある。
rem TRUST_PROXY=1: トンネル経由だと全員が同じ接続元に見えるので、相手ごとの回数制限が効くよう、トンネルが付ける接続元を使う
rem 管理用の削除を使うなら、起動前に  set ADMIN_TOKEN=好きな合言葉  を足す
cd /d "%~dp0"
set TRUST_PROXY=1
start "cursor-run-server" cmd /k node server.js
timeout /t 2 /nobreak >nul
echo 表示される https://xxxx.trycloudflare.com を共有してください
cloudflared tunnel --url http://localhost:8080 --no-autoupdate
