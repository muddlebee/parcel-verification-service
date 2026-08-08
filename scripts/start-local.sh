#!/usr/bin/env bash
# Start Postgres + Redis, wait until healthy, migrate, then run the app.
# Usage: scripts/start-local.sh [start|dev]
set -euo pipefail

MODE="${1:-start}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ "$MODE" != "start" && "$MODE" != "dev" ]]; then
  echo "Usage: $0 [start|dev]" >&2
  exit 2
fi

echo "→ Starting Postgres and Redis..."
if ! docker compose up -d postgres redis; then
  echo "✗ Failed to start docker services. Is something already bound to :5432 / :6379?" >&2
  docker compose ps postgres redis || true
  exit 1
fi

bash scripts/wait-for-deps.sh

echo "→ Running migrations..."
npm run migrate:up

if [[ "$MODE" == "dev" ]]; then
  echo "→ Starting app (tsx watch src/index.ts)..."
  exec npm run dev
fi

echo "→ Starting app (tsx src/index.ts)..."
exec npx tsx src/index.ts
