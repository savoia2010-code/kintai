#!/bin/bash
cd "$(dirname "$0")"

PORT=8080

# Start a server in the background only if the port is not already listening
if ! lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  if command -v python3 >/dev/null 2>&1; then
    nohup python3 -m http.server $PORT >/dev/null 2>&1 &
  elif command -v ruby >/dev/null 2>&1; then
    nohup ruby -run -e httpd . -p $PORT >/dev/null 2>&1 &
  else
    echo "python3 も ruby も見つかりません。"
    echo "ターミナルで 'xcode-select --install' を実行して python3 を用意してください。"
    read -n 1 -s -r -p "何かキーを押すと閉じます..."
    exit 1
  fi
  sleep 1
fi

open "http://localhost:$PORT"
