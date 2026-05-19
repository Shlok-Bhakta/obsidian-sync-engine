#!/usr/bin/env bash
set -euo pipefail

image="${POSTGRES_IMAGE:-postgres:16-alpine}"
container_name="${POSTGRES_CONTAINER_NAME:-obsidian-sync-engine-test-$RANDOM}"
host_port="${POSTGRES_TEST_PORT:-55432}"
database="${POSTGRES_DB:-obsidian_sync_engine_test}"
user="${POSTGRES_USER:-postgres}"
password="${POSTGRES_PASSWORD:-postgres}"

cleanup() {
  docker rm -f "$container_name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run \
  --name "$container_name" \
  -e POSTGRES_DB="$database" \
  -e POSTGRES_USER="$user" \
  -e POSTGRES_PASSWORD="$password" \
  -p "127.0.0.1:$host_port:5432" \
  -d "$image" >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$container_name" pg_isready -U "$user" -d "$database" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! docker exec "$container_name" pg_isready -U "$user" -d "$database" >/dev/null 2>&1; then
  echo "Postgres did not become ready in time" >&2
  exit 1
fi

export DATABASE_URL="postgres://$user:$password@127.0.0.1:$host_port/$database"
export POSTGRES_URL="$DATABASE_URL"
bun test src/sync/engine.integration.test.ts
