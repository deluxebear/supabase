#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
port="${FLEET_CONTROL_TEST_POSTGRES_PORT:-55439}"
project="supabase-fleet-control-t4-${PPID}"
compose=(docker compose -p "$project" -f "$root/test/e2e/fleet-control-postgres.compose.yml")

cleanup() {
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

"${compose[@]}" up -d --wait fleet-control-db
(cd "$root" && \
  FLEET_CONTROL_TEST_POSTGRES_DSN="postgres://fleet_control:fleet-control-test@127.0.0.1:${port}/fleet_control?sslmode=disable" \
    go test ./internal/fleetcontrol -run '^TestFleetPostgresStoreCompatibility$' -count=1)
printf 'RESULT=PASS fleet_store=postgres schema_version=1 backup_domain_tables=absent\n'
