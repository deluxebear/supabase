#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "$0")/.."
compose=(docker compose --env-file control-plane.env -f docker-compose.control-plane.yml)
evidence_dir="$(mktemp -d "${TMPDIR:-/tmp}/supabase-fleet-dr.XXXXXX")"
chmod 700 "$evidence_dir"

cleanup() {
  "${compose[@]}" exec -T platform-db dropdb -U postgres --if-exists t10_drill_platform >/dev/null 2>&1 || true
  "${compose[@]}" exec -T fleet-control-db dropdb -U fleet_control --if-exists t10_drill_fleet >/dev/null 2>&1 || true
  "${compose[@]}" exec -T backup-operator-db dropdb -U backup_operator --if-exists t10_drill_backup >/dev/null 2>&1 || true
  rm -rf "$evidence_dir"
}
trap cleanup EXIT

for file in control-plane.env secrets/fleet-management/ca.crt secrets/fleet-management/ca.key secrets/fleet-management/server.crt secrets/fleet-management/server.key; do
  test -s "$file" || { printf 'required recovery material missing: %s\n' "$file" >&2; exit 1; }
done

tar -czf "$evidence_dir/control-authorities.tgz" control-plane.env secrets/fleet-management
chmod 600 "$evidence_dir/control-authorities.tgz"
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$evidence_dir/control-authorities.tgz" > "$evidence_dir/control-authorities.tgz.sha256"
else
  shasum -a 256 "$evidence_dir/control-authorities.tgz" > "$evidence_dir/control-authorities.tgz.sha256"
fi

"${compose[@]}" exec -T platform-db pg_dump -U postgres -d platform -Fc > "$evidence_dir/platform.dump"
"${compose[@]}" exec -T fleet-control-db pg_dump -U fleet_control -d fleet_control -Fc > "$evidence_dir/fleet-control.dump"
"${compose[@]}" exec -T backup-operator-db pg_dump -U backup_operator -d backup_operator -Fc > "$evidence_dir/backup-operator.dump"

"${compose[@]}" exec -T platform-db createdb -U postgres t10_drill_platform
"${compose[@]}" exec -T fleet-control-db createdb -U fleet_control t10_drill_fleet
"${compose[@]}" exec -T backup-operator-db createdb -U backup_operator t10_drill_backup
"${compose[@]}" exec -T platform-db pg_restore -U postgres -d t10_drill_platform --no-owner < "$evidence_dir/platform.dump"
"${compose[@]}" exec -T fleet-control-db pg_restore -U fleet_control -d t10_drill_fleet --no-owner < "$evidence_dir/fleet-control.dump"
"${compose[@]}" exec -T backup-operator-db pg_restore -U backup_operator -d t10_drill_backup --no-owner < "$evidence_dir/backup-operator.dump"

"${compose[@]}" exec -T platform-db psql -U postgres -d t10_drill_platform -Atqc \
  "select count(*) from platform.schema_migrations" | grep -Eq '^[1-9][0-9]*$'
"${compose[@]}" exec -T fleet-control-db psql -U fleet_control -d t10_drill_fleet -Atqc \
  "select max(version) from schema_migrations" | grep -qx '6'
"${compose[@]}" exec -T backup-operator-db psql -U backup_operator -d t10_drill_backup -Atqc \
  "select count(*) from schema_migrations" | grep -Eq '^[1-9][0-9]*$'

if "${compose[@]}" run --rm --no-deps \
  -e FLEET_CONTROL_AGENT_CA_KEY=/run/secrets/fleet-management/missing-ca.key \
  fleet-control --listen=127.0.0.1:18090 --enrollment-listen=127.0.0.1:18091 --agent-listen=127.0.0.1:18092 \
  >"$evidence_dir/missing-key.log" 2>&1; then
  printf 'Fleet Control unexpectedly became ready without its CA key\n' >&2
  exit 1
fi
grep -Eq 'CA private key|no such file|read Fleet Agent CA' "$evidence_dir/missing-key.log"
curl -fsS "http://127.0.0.1:${FLEET_CONTROL_HTTP_PORT:-8090}/readyz" | grep -q '"schemaVersion":6'

printf 'RESULT=PASS platform_restore=verified fleet_restore=verified backup_restore=verified key_bundle=verified missing_key_readiness=failed_closed\n'
