#!/usr/bin/env bash
set -euo pipefail

# Destructive M0 spike. It only operates on resources carrying this unique
# prefix and never accepts SQL, container, volume, or path input from callers.
prefix="codex-controlstore-spike-$$"
target_container="${prefix}-target"
control_container="${prefix}-control"
target_data="${prefix}-target-data"
target_repo="${prefix}-target-repo"
control_data="${prefix}-control-data"
empty_init="${prefix}-empty-init"
sqlite_dir="$(mktemp -d "${TMPDIR:-/tmp}/${prefix}.XXXXXX")"
sqlite_file="${sqlite_dir}/control.db"
image="deluxebear/postgres:17"
password="control-store-spike-only"
pgbackrest="/usr/lib/pgbackrest/bin/pgbackrest.real"

cleanup() {
  docker rm -f "$target_container" "$control_container" >/dev/null 2>&1 || true
  docker volume rm "$target_data" "$target_repo" "$control_data" "$empty_init" >/dev/null 2>&1 || true
  rm -rf "$sqlite_dir"
}
trap cleanup EXIT

wait_ready() {
  local container="$1"
  local logs
  for _ in $(seq 1 120); do
    logs="$(docker logs "$container" 2>&1)"
    if [[ "$logs" == *"PostgreSQL init process complete"* ]] && \
      docker exec "$container" psql -U postgres -d postgres -Atqc "select 1" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  docker logs "$container" >&2
  return 1
}

docker volume create "$target_data" >/dev/null
docker volume create "$target_repo" >/dev/null
docker volume create "$control_data" >/dev/null
docker volume create "$empty_init" >/dev/null

docker run -d --name "$target_container" \
  -e POSTGRES_PASSWORD="$password" \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_DB=postgres \
  -v "$target_data:/var/lib/postgresql/data" \
  -v "$target_repo:/var/lib/pgbackrest" \
  --mount "type=volume,src=$empty_init,dst=/docker-entrypoint-initdb.d,volume-nocopy" \
  "$image" >/dev/null

docker run -d --name "$control_container" \
  -e POSTGRES_PASSWORD="$password" \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_DB=postgres \
  -v "$control_data:/var/lib/postgresql/data" \
  --mount "type=volume,src=$empty_init,dst=/docker-entrypoint-initdb.d,volume-nocopy" \
  "$image" >/dev/null

wait_ready "$target_container"
wait_ready "$control_container"

# All SQL below is hardcoded in this repository. No caller-controlled fragment
# is interpolated into a query.
docker exec "$control_container" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c \
  "create table control_jobs(id bigint primary key, state text not null); insert into control_jobs values (1, 'running');" >/dev/null
sqlite3 "$sqlite_file" "create table control_jobs(id integer primary key, state text not null); insert into control_jobs values (1, 'running');"

target_system_id="$(docker exec "$target_container" psql -U postgres -d postgres -Atqc "select (pg_control_system()).system_identifier")"
control_system_id="$(docker exec "$control_container" psql -U postgres -d postgres -Atqc "select (pg_control_system()).system_identifier")"

go run ./cmd/recovery-domain-check \
  --target-system-id "$target_system_id" \
  --target-data-domain "$target_data" \
  --control-system-id "$control_system_id" \
  --control-data-domain "$control_data"

if go run ./cmd/recovery-domain-check \
  --target-system-id "$target_system_id" \
  --target-data-domain "$target_data" \
  --control-system-id "$target_system_id" \
  --control-data-domain "$control_data" >/dev/null 2>&1; then
  echo "same-system-identifier registration was not rejected" >&2
  exit 1
fi

if go run ./cmd/recovery-domain-check \
  --target-system-id "$target_system_id" \
  --target-data-domain "$target_data" \
  --control-system-id "$control_system_id" \
  --control-data-domain "$target_data" >/dev/null 2>&1; then
  echo "shared-data-domain registration was not rejected" >&2
  exit 1
fi

# Configure a local pgBackRest repository entirely inside the target spike.
docker exec --user root "$target_container" sh -c \
  "chown -R postgres:postgres /var/lib/pgbackrest && cat > /var/lib/pgbackrest/spike.conf <<'EOF'
[global]
repo1-type=posix
repo1-path=/var/lib/pgbackrest/repo
repo1-retention-full=2
start-fast=y

[spike]
pg1-path=/var/lib/postgresql/data
pg1-socket-path=/var/run/postgresql
pg1-user=postgres
EOF
mkdir -p /var/lib/pgbackrest/repo && chown -R postgres:postgres /var/lib/pgbackrest"

docker exec "$target_container" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c \
  "alter system set archive_mode = 'on'" >/dev/null
docker exec "$target_container" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c \
  "alter system set archive_command = '$pgbackrest --config=/var/lib/pgbackrest/spike.conf --stanza=spike archive-push %p'" >/dev/null
docker restart "$target_container" >/dev/null
wait_ready "$target_container"

docker exec --user postgres "$target_container" "$pgbackrest" \
  --config=/var/lib/pgbackrest/spike.conf --stanza=spike --log-level-console=info stanza-create
docker exec --user postgres "$target_container" "$pgbackrest" \
  --config=/var/lib/pgbackrest/spike.conf --stanza=spike --log-level-console=info check

docker exec "$target_container" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c \
  "create table recovery_markers(id bigint primary key, value text not null); insert into recovery_markers values (1, 'before-target');" >/dev/null
docker exec --user postgres "$target_container" "$pgbackrest" \
  --config=/var/lib/pgbackrest/spike.conf --stanza=spike --log-level-console=info --type=full backup
docker exec "$target_container" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c \
  "select pg_create_restore_point('control_store_spike_target'); insert into recovery_markers values (2, 'after-target'); select pg_switch_wal();" >/dev/null

# Wait for the target WAL to reach the repository before stopping PostgreSQL.
docker exec --user postgres "$target_container" "$pgbackrest" \
  --config=/var/lib/pgbackrest/spike.conf --stanza=spike --log-level-console=info check
docker stop "$target_container" >/dev/null

docker run --rm --volumes-from "$target_container" --user postgres \
  --entrypoint "$pgbackrest" "$image" \
  --config=/var/lib/pgbackrest/spike.conf --stanza=spike --delta \
  --log-level-console=info --type=name --target=control_store_spike_target --target-action=promote restore

docker start "$target_container" >/dev/null
wait_ready "$target_container"

target_rows="$(docker exec "$target_container" psql -U postgres -d postgres -Atqc "select string_agg(value, ',' order by id) from recovery_markers")"
postgres_control_state="$(docker exec "$control_container" psql -U postgres -d postgres -Atqc "select state from control_jobs where id = 1")"
sqlite_control_state="$(sqlite3 "$sqlite_file" "select state from control_jobs where id = 1;")"

test "$target_rows" = "before-target"
test "$postgres_control_state" = "running"
test "$sqlite_control_state" = "running"

printf 'target_system_id=%s\n' "$target_system_id"
printf 'control_system_id=%s\n' "$control_system_id"
printf 'target_after_pitr=%s\n' "$target_rows"
printf 'postgres_control_after_pitr=%s\n' "$postgres_control_state"
printf 'sqlite_control_after_pitr=%s\n' "$sqlite_control_state"
printf 'RESULT=PASS\n'
