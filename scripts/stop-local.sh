#!/usr/bin/env bash
# Stop local Docker deps (Postgres + Redis) started by start-local / dev:local.
# Usage: scripts/stop-local.sh [--down]
#   default  stop containers (keeps volumes/data)
#   --down   stop and remove containers (volumes kept unless compose down -v)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ "${1:-}" == "--down" ]]; then
  echo "→ Stopping and removing Postgres and Redis containers..."
  docker compose stop postgres redis
  docker compose rm -f postgres redis
  echo "✓ Local deps removed (data volumes kept)."
  exit 0
fi

if [[ -n "${1:-}" ]]; then
  echo "Usage: $0 [--down]" >&2
  exit 2
fi

echo "→ Stopping Postgres and Redis..."
docker compose stop postgres redis
echo "✓ Local deps stopped. Restart with: npm run start:local / npm run dev:local"
