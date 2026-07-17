#!/usr/bin/env bash
set -Eeuo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${CONTROL_PLANE_ENV_FILE:-$root_dir/control-plane.env}"
project_name="${COMPOSE_PROJECT_NAME:-supabase-fleet-control}"
compose=(docker compose -p "$project_name" --env-file "$env_file" -f "$root_dir/docker-compose.control-plane.yml")
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="${CONTROL_PLANE_MIGRATION_BACKUP_DIR:-$root_dir/.migration-backups/$timestamp}"
stopped_containers=()
migration_complete=0

[ -f "$env_file" ] || {
  printf 'ERROR: control-plane environment is missing: %s\n' "$env_file" >&2
  exit 1
}

envval() { grep -E "^$1=" "$env_file" | head -1 | cut -d= -f2- | tr -d '\r'; }
container_for() {
  docker ps -aq \
    --filter "label=com.docker.compose.project=$project_name" \
    --filter "label=com.docker.compose.service=$1" | head -1
}

platform_db="$(container_for platform-db)"
fleet_db="$(container_for fleet-control-db)"
backup_db="$(container_for backup-operator-db)"
for value in platform_db fleet_db backup_db; do
  [ -n "${!value}" ] || {
    printf 'ERROR: legacy %s container was not found; migration requires the three-database topology to still exist\n' "$value" >&2
    exit 1
  }
done

fleet_system_identifier="$(envval FLEET_CONTROL_STORE_SYSTEM_IDENTIFIER)"
fleet_data_domain="$(envval FLEET_CONTROL_STORE_DATA_DOMAIN)"
backup_system_identifier="$(envval BACKUP_OPERATOR_CONTROL_STORE_SYSTEM_IDENTIFIER)"
backup_data_domain="$(envval BACKUP_OPERATOR_CONTROL_STORE_DATA_DOMAIN)"
for value in fleet_system_identifier fleet_data_domain backup_system_identifier backup_data_domain; do
  [ -n "${!value}" ] || {
    printf 'ERROR: %s must be configured in %s\n' "$value" "$env_file" >&2
    exit 1
  }
done

fleet_schema_version="$(docker exec "$fleet_db" psql -U fleet_control -d fleet_control -Atqc \
  'select max(version) from schema_migrations')"
backup_schema_count="$(docker exec "$backup_db" psql -U backup_operator -d backup_operator -Atqc \
  'select count(*) from schema_migrations')"
[[ "$fleet_schema_version" =~ ^[1-9][0-9]*$ ]] || {
  printf 'ERROR: could not read the Fleet Control schema version\n' >&2
  exit 1
}
[[ "$backup_schema_count" =~ ^[1-9][0-9]*$ ]] || {
  printf 'ERROR: could not read the Backup Operator migration count\n' >&2
  exit 1
}

restore_legacy_processes() {
  if [ "$migration_complete" -eq 0 ] && [ "${#stopped_containers[@]}" -gt 0 ]; then
    printf 'Migration failed; attempting to restart the original application containers.\n' >&2
    docker start "${stopped_containers[@]}" >/dev/null 2>&1 || true
  fi
}
trap restore_legacy_processes EXIT

mkdir -p "$backup_dir"
chmod 0700 "$backup_dir"

for service in gateway studio platform-auth platform-outbox-dispatcher fleet-control backup-operator backup-operator-tls; do
  container="$(container_for "$service")"
  if [ -n "$container" ] && [ "$(docker inspect -f '{{.State.Running}}' "$container")" = true ]; then
    stopped_containers+=("$container")
  fi
done
if [ "${#stopped_containers[@]}" -gt 0 ]; then
  docker stop "${stopped_containers[@]}" >/dev/null
fi

docker exec "$platform_db" pg_dump -U postgres -d platform -Fc > "$backup_dir/platform.dump"
docker exec "$fleet_db" pg_dump -U fleet_control -d fleet_control -Fc > "$backup_dir/fleet-control.dump"
docker exec "$backup_db" pg_dump -U backup_operator -d backup_operator -Fc > "$backup_dir/backup-operator.dump"
chmod 0600 "$backup_dir"/*.dump

"${compose[@]}" run --rm control-db-init

for database in fleet_control backup_operator; do
  docker exec "$platform_db" dropdb -U postgres --force --if-exists "$database"
done
docker exec "$platform_db" createdb -U postgres -O fleet_control fleet_control
docker exec "$platform_db" createdb -U postgres -O backup_operator backup_operator

docker exec -i "$platform_db" pg_restore -U fleet_control -d fleet_control --no-owner --exit-on-error < "$backup_dir/fleet-control.dump"
docker exec -i "$platform_db" pg_restore -U backup_operator -d backup_operator --no-owner --exit-on-error < "$backup_dir/backup-operator.dump"

docker exec -i "$platform_db" psql -U fleet_control -d fleet_control -v ON_ERROR_STOP=1 \
  --set=system_identifier="$fleet_system_identifier" --set=data_domain="$fleet_data_domain" <<'SQL'
update store_identity
set system_identifier = :'system_identifier', data_domain = :'data_domain'
where singleton = 1;
SQL
docker exec -i "$platform_db" psql -U backup_operator -d backup_operator -v ON_ERROR_STOP=1 \
  --set=system_identifier="$backup_system_identifier" --set=data_domain="$backup_data_domain" <<'SQL'
update store_identity
set system_identifier = :'system_identifier', data_domain = :'data_domain'
where singleton = 1;
SQL

docker exec "$platform_db" psql -U fleet_control -d fleet_control -Atqc \
  "select max(version) from schema_migrations" | grep -qx "$fleet_schema_version"
docker exec "$platform_db" psql -U backup_operator -d backup_operator -Atqc \
  "select count(*) from schema_migrations" | grep -qx "$backup_schema_count"

"${compose[@]}" up -d --remove-orphans

"${compose[@]}" exec -T platform-db psql -U postgres -d postgres -Atqc \
  "select datname from pg_database where datname in ('platform','fleet_control','backup_operator') order by datname" \
  | grep -qx $'backup_operator\nfleet_control\nplatform'
fleet_port="$(envval FLEET_CONTROL_HTTP_PORT)"; fleet_port="${fleet_port:-8090}"
ready=0
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$fleet_port/readyz" | grep -q "\"schemaVersion\":$fleet_schema_version"; then
    ready=1
    break
  fi
  sleep 2
done
[ "$ready" -eq 1 ] || {
  printf 'ERROR: Fleet Control did not become ready after the database migration\n' >&2
  exit 1
}
"${compose[@]}" exec -T platform-db psql -U backup_operator -d backup_operator -Atqc \
  "select system_identifier || '|' || data_domain from store_identity where singleton = 1" \
  | grep -qx "$backup_system_identifier|$backup_data_domain"

migration_complete=1
trap - EXIT
printf 'RESULT=PASS single_postgres=ready legacy_dumps=%s legacy_volumes=retained\n' "$backup_dir"
