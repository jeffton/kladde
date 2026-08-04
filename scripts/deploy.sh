#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
server_binary=$(mktemp)
trap 'rm -f "$server_binary"' EXIT

cd "$repo_root/client"
npm run build

cd "$repo_root/server"
go build -o "$server_binary" .

sudo rsync \
  -a \
  --delete-delay \
  --delay-updates \
  --chown=kladde:kladde \
  "$repo_root/client/dist/" \
  /var/lib/kladde/dist/
sudo install -o root -g root -m 0755 "$server_binary" /usr/local/bin/kladde
sudo systemctl restart kladde
sudo systemctl is-active --quiet kladde

for _ in {1..20}; do
  if curl --fail --silent --show-error http://127.0.0.1:8092/api/health >/dev/null; then
    exit 0
  fi
  sleep 0.5
done

echo "Kladde health check failed after deployment" >&2
exit 1
