#!/usr/bin/env bash
# 看门狗：每 15 秒探测 localhost:8787，掉线则自动拉起 proxy/server.mjs
# 用法：bash proxy/watchdog.sh   （建议后台运行）
NODE="/c/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2/node.exe"
DIR="/e/LC_DATA/syncDisk/AiData/projectFile/wayToAgi/dine"
while true; do
  if ! curl -s -m 2 "http://localhost:8787/api/status" >/dev/null 2>&1; then
    echo "[watchdog $(date +%H:%M:%S)] proxy down -> restarting" >> /tmp/watchdog.log
    cd "$DIR" && "$NODE" proxy/server.mjs >> /tmp/proxy.log 2>&1 &
  fi
  sleep 15
done
