#!/bin/bash
# PDF仕分けアシスタント(ローカル版)を起動します。ダブルクリックで実行してください。
# 初めての起動では設定ファイルを自動で作り、画面の「設定」が開きます。
cd "$(dirname "$0")/.." || exit 1
if [ ! -d node_modules ]; then
  echo "初回の準備をしています。少しお待ちください..."
  npm install --omit=dev
fi
node local/server.js --config local/config.json
