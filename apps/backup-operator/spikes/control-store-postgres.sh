#!/usr/bin/env bash
set -euo pipefail

container="backup-control-store-postgres-$$"
password="control-store-spike-only"

cleanup() {
  docker rm -f "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run -d --name "$container" \
  -p 127.0.0.1::5432 \
  -e POSTGRES_PASSWORD="$password" -e POSTGRES_DB=control \
  postgres:17-bookworm >/dev/null

for _ in $(seq 1 120); do
  if docker exec "$container" pg_isready -U postgres -d control >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$container" pg_isready -U postgres -d control >/dev/null

port="$(docker inspect -f '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}' "$container")"
CONTROLSTORE_POSTGRES_TEST_DSN="postgres://postgres:${password}@127.0.0.1:${port}/control?sslmode=disable" \
  go test ./internal/controlstore ./internal/observation -run 'TestPostgres.*Integration' -count=1 -v
