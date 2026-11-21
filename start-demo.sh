#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
NODE="${NODE:-node}"
if ! command -v "$NODE" >/dev/null 2>&1; then
  echo "未找到 Node.js。请先安装 Node.js 24 或更高版本：https://nodejs.org/" >&2
  exit 1
fi
exec "$NODE" start-demo.mjs
