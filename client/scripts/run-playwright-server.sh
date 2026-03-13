#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$ROOT/tmp/playwright"

rm -rf "$TMP_DIR"
mkdir -p "$TMP_DIR/notes" "$ROOT/client/screenshots"

cat > "$TMP_DIR/options.json" <<JSON
{
  "addr": "127.0.0.1:8080",
  "notes": "$TMP_DIR/notes",
  "client": "$ROOT/client/dist"
}
JSON

cd "$ROOT/client"
npm run build

cd "$ROOT/server"
go run . adduser \
  --users "$TMP_DIR/users.json" \
  --username admin \
  --password testpass123 \
  --name Admin >/dev/null

exec go run . -options "$TMP_DIR"
