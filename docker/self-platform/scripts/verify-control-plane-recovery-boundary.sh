#!/usr/bin/env bash
set -Eeuo pipefail

cd "$(dirname "$0")/.."
compose=(docker compose --env-file control-plane.env -f docker-compose.control-plane.yml)

cleanup() {
  "${compose[@]}" start >/dev/null 2>&1 || true
}
trap cleanup EXIT

"${compose[@]}" exec -T platform-db psql -U postgres -d platform -v ON_ERROR_STOP=1 <<'SQL'
create table if not exists platform.t3_recovery_evidence(id integer primary key, value text not null);
insert into platform.t3_recovery_evidence values (1, 'registry-survived') on conflict (id) do update set value=excluded.value;
SQL
"${compose[@]}" exec -T fleet-control-db psql -U fleet_control -d fleet_control -v ON_ERROR_STOP=1 <<'SQL'
create table if not exists t3_operation_evidence(id integer primary key, state text not null);
insert into t3_operation_evidence values (1, 'durable') on conflict (id) do update set state=excluded.state;
SQL
curl -fsS "http://127.0.0.1:${FLEET_CONTROL_HTTP_PORT:-8090}/readyz" | grep -q '"service":"fleet-control"'

before_jobs=$("${compose[@]}" exec -T backup-operator-db psql -U backup_operator -d backup_operator -Atqc "select count(*) from jobs")

# Only the managed stack is stopped. The control compose project and all three
# control stores must remain available throughout the outage.
docker compose -f docker-compose.yml stop db auth rest realtime storage meta functions supavisor

"${compose[@]}" exec -T platform-db psql -U postgres -d platform -Atqc \
  "select value from platform.t3_recovery_evidence where id=1" | grep -qx registry-survived
"${compose[@]}" exec -T fleet-control-db psql -U fleet_control -d fleet_control -Atqc \
  "select state from t3_operation_evidence where id=1" | grep -qx durable
curl -fsS "http://127.0.0.1:${FLEET_CONTROL_HTTP_PORT:-8090}/readyz" | grep -q '"schemaVersion":5'
"${compose[@]}" exec -T backup-operator-db psql -U backup_operator -d backup_operator -Atqc \
  "select count(*) from jobs" | grep -qx "$before_jobs"
curl -fsS "${FLEET_PUBLIC_URL:-$(grep '^FLEET_PUBLIC_URL=' control-plane.env | cut -d= -f2-)}/api/platform/telemetry/feature-flags" >/dev/null

docker compose -f docker-compose.yml start db auth rest realtime storage meta functions supavisor
printf 'RESULT=PASS platform_registry=available fleet_operations=durable backup_evidence=durable login_surface=available\n'
