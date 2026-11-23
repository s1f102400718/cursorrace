@echo off
rem Cursor Run: ゲームサーバーと Cloudflare Tunnel をまとめて起動する
rem 前提: このフォルダで npm install 済み。cloudflared.exe が PATH にあるか、このフォルダに置いてある。
cd /d "%~dp0"
start "cursor-run-server" cmd /k node server.js
timeout /t 2 /nobreak >nul
echo 表示される https://xxxx.trycloudflare.com に ?room=abc を付けて共有してください
cloudflared tunnel --url http://localhost:8080 --no-autoupdate
