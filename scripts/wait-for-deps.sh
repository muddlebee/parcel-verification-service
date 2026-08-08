#!/usr/bin/env bash
# Block until docker-compose postgres + redis report healthy.
set -euo pipefail

WAIT_TIMEOUT_SEC="${WAIT_TIMEOUT_SEC:-90}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

service_id() {
  docker compose ps -q "$1" 2>/dev/null || true
}

service_status() {
  local id="$1"
  if [[ -z "$id" ]]; then
    echo "missing"
    return
  fi
  docker inspect -f '{{.State.Status}}' "$id" 2>/dev/null || echo missing
}

service_health() {
  local id="$1"
  if [[ -z "$id" ]]; then
    echo "missing"
    return
  fi
  # Prefer healthcheck; fall back to container status when no healthcheck is defined.
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || echo missing
}

is_ready() {
  local health="$1"
  [[ "$health" == "healthy" || "$health" == "running" ]]
}

is_failed() {
  local status="$1"
  # created/exited/dead never become healthy without a successful start.
  [[ "$status" == "exited" || "$status" == "dead" || "$status" == "missing" ]]
}

echo "→ Waiting for Postgres and Redis to become healthy (timeout ${WAIT_TIMEOUT_SEC}s)..."
deadline=$((SECONDS + WAIT_TIMEOUT_SEC))
# Allow a short window for containers to leave "created" after `compose up`.
created_grace_sec=5
started_at=$SECONDS

while true; do
  pg_id="$(service_id postgres)"
  redis_id="$(service_id redis)"
  pg_status="$(service_status "$pg_id")"
  redis_status="$(service_status "$redis_id")"
  pg_health="$(service_health "$pg_id")"
  redis_health="$(service_health "$redis_id")"

  if is_ready "$pg_health" && is_ready "$redis_health"; then
    echo "✓ Postgres and Redis are ready (postgres=$pg_health redis=$redis_health)."
    exit 0
  fi

  if is_failed "$pg_status" || is_failed "$redis_status"; then
    echo "✗ Dependency containers failed to run (postgres=$pg_status redis=$redis_status)." >&2
    echo "  Check ports :5432 / :6379 and run: docker compose ps postgres redis" >&2
    docker compose ps postgres redis || true
    exit 1
  fi

  # Stuck in "created" past grace period usually means a prior bind failure.
  if (( SECONDS - started_at >= created_grace_sec )); then
    if [[ "$pg_status" == "created" || "$redis_status" == "created" ]]; then
      echo "✗ Containers stuck in 'created' (postgres=$pg_status redis=$redis_status)." >&2
      echo "  Often a port conflict on :5432 / :6379. Free the ports or stop the other stack, then:" >&2
      echo "    docker compose rm -f postgres redis && docker compose up -d postgres redis" >&2
      docker compose ps postgres redis || true
      exit 1
    fi
  fi

  if (( SECONDS >= deadline )); then
    echo "✗ Timed out waiting for dependencies (postgres=$pg_health redis=$redis_health)." >&2
    docker compose ps postgres redis || true
    exit 1
  fi

  printf '  … postgres=%s redis=%s\n' "$pg_health" "$redis_health"
  sleep 1
done
