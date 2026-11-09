@echo off
chcp 65001 > nul
rem PDF仕分けアシスタント(ローカル版)を起動します。ダブルクリックで実行してください。
cd /d "%~dp0.."
if not exist local\config.json (
  echo 設定ファイル local\config.json がありません。local\config.sample.json をコピーして作ってください。
  pause
  exit /b 1
)
if not exist node_modules (
  echo 初回の準備をしています。少しお待ちください...
  call npm install --omit=dev
)
node local\server.js --config local\config.json
pause
