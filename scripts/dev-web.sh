#!/usr/bin/env sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

cleanup() {
  if [ -n "${API_PID:-}" ]; then kill "$API_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM

go run ./server &
API_PID=$!

cd frontend
if [ ! -d node_modules ]; then npm install; fi
npm run dev
