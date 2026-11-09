#!/bin/bash
# PDF仕分けアシスタント(ローカル版)を起動します。ダブルクリックで実行してください。
cd "$(dirname "$0")/.." || exit 1
if [ ! -f local/config.json ]; then
  echo "設定ファイル local/config.json がありません。local/config.sample.json をコピーして作ってください。"
  read -r -p "Enter キーで閉じます"
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "初回の準備をしています。少しお待ちください..."
  npm install --omit=dev
fi
node local/server.js --config local/config.json
