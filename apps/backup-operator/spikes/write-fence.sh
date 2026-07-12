#!/usr/bin/env bash
set -euo pipefail

# Destructive M0 spike. All resources and SQL identities are fixed and scoped
# to containers carrying this unique prefix. No caller input is accepted.
prefix="supabase-fence-spike-$$"
network="${prefix}-net"
db="${prefix}-db"
data_plane="${prefix}-data-plane"
pooler="${prefix}-pooler"
direct="${prefix}-direct"
image="deluxebear/postgres:17"
password="fence-spike-only"

cleanup() {
  docker rm -f "$data_plane" "$pooler" "$direct" "$db" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT

psql_control() {
  docker exec "$db" psql -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"
}

wait_database() {
  local consecutive=0
  for _ in $(seq 1 120); do
    if docker exec "$db" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
      consecutive=$((consecutive + 1))
      [ "$consecutive" -ge 5 ] && return 0
    else
      consecutive=0
    fi
    if [ "$(docker inspect -f '{{.State.Status}}' "$db" 2>/dev/null || true)" = "exited" ]; then
      docker logs "$db" >&2
      return 1
    fi
    sleep 1
  done
  docker logs "$db" >&2
  return 1
}

start_writer() {
  local name="$1"
  docker run -d --name "$name" --network "$network" \
    -e PGPASSWORD="$password" -e PGAPPNAME="$(basename "$name")" \
    --entrypoint sh "$image" -c \
    'while true; do psql -h db -U app_writer -d postgres -v ON_ERROR_STOP=1 -c "insert into fence_writes(source) values (current_setting('"'"'application_name'"'"')); select pg_sleep(2)" || true; sleep 1; done' \
    >/dev/null
}

docker network create "$network" >/dev/null
docker run -d --name "$db" --network "$network" --network-alias db \
  -e POSTGRES_PASSWORD="$password" -e POSTGRES_DB=postgres \
  "$image" postgres -c config_file=/etc/postgresql/postgresql.conf \
  -c max_prepared_transactions=10 >/dev/null
wait_database

psql_control -c "create role app_writer login password '$password'; grant connect on database postgres to app_writer; create table fence_writes(id bigserial primary key, source text not null, created_at timestamptz not null default now()); grant insert, select on fence_writes to app_writer; grant usage, select on sequence fence_writes_id_seq to app_writer;" >/dev/null

start_writer "$data_plane"
start_writer "$pooler"
start_writer "$direct"
for _ in $(seq 1 30); do
  active_before="$(psql_control -Atqc "select count(*) from pg_stat_activity where usename = 'app_writer'")"
  [ "$active_before" -ge 1 ] && break
  sleep 1
done
if [ "$active_before" -lt 1 ]; then
  docker logs "$data_plane" >&2
  docker logs "$pooler" >&2
  docker logs "$direct" >&2
  exit 1
fi

psql_control -c "begin; insert into fence_writes(source) values ('prepared'); prepare transaction 'fence_spike_prepared';" >/dev/null
prepared_before="$(psql_control -Atqc "select count(*) from pg_prepared_xacts where gid = 'fence_spike_prepared'")"
test "$prepared_before" = "1"
test "$active_before" -ge 1

# Layer 1: remove routable Supabase data-plane and pooler paths.
docker stop "$data_plane" "$pooler" >/dev/null

# Layer 2: fence direct PostgreSQL access before terminating existing sessions.
psql_control -c "alter role app_writer nologin; alter role app_writer set default_transaction_read_only = on; revoke connect on database postgres from app_writer;" >/dev/null
psql_control -c "rollback prepared 'fence_spike_prepared';" >/dev/null
psql_control -c "select pg_terminate_backend(pid) from pg_stat_activity where usename = 'app_writer' and pid <> pg_backend_pid();" >/dev/null

for _ in $(seq 1 30); do
  active_after="$(psql_control -Atqc "select count(*) from pg_stat_activity where usename = 'app_writer'")"
  [ "$active_after" = "0" ] && break
  sleep 1
done

prepared_after="$(psql_control -Atqc "select count(*) from pg_prepared_xacts")"
data_plane_state="$(docker inspect -f '{{.State.Status}}' "$data_plane")"
pooler_state="$(docker inspect -f '{{.State.Status}}' "$pooler")"
direct_state="$(docker inspect -f '{{.State.Status}}' "$direct")"
control_sql="$(psql_control -Atqc 'select 1')"

set +e
docker exec -e PGPASSWORD="$password" "$direct" psql -h db -U app_writer -d postgres -Atqc 'select 1' >/dev/null 2>&1
direct_login_status=$?
set -e

test "$data_plane_state" = "exited"
test "$pooler_state" = "exited"
test "$direct_state" = "running"
test "$active_after" = "0"
test "$prepared_after" = "0"
test "$control_sql" = "1"
test "$direct_login_status" -ne 0

rows_at_fence="$(psql_control -Atqc 'select count(*) from fence_writes')"
sleep 4
test "$(psql_control -Atqc 'select count(*) from fence_writes')" = "$rows_at_fence"

# Release is a separate, explicit operation. It restores the database role but
# does not implicitly restart stopped data-plane components.
psql_control -c "grant connect on database postgres to app_writer; alter role app_writer login; alter role app_writer reset default_transaction_read_only;" >/dev/null
for _ in $(seq 1 30); do
  rows_after_release="$(psql_control -Atqc 'select count(*) from fence_writes')"
  [ "$rows_after_release" -gt "$rows_at_fence" ] && break
  sleep 1
done
test "$rows_after_release" -gt "$rows_at_fence"

printf 'data_plane_state=%s\n' "$data_plane_state"
printf 'pooler_state=%s\n' "$pooler_state"
printf 'direct_client_state=%s\n' "$direct_state"
printf 'active_app_sessions_before=%s\n' "$active_before"
printf 'active_app_sessions_after=%s\n' "$active_after"
printf 'prepared_transactions_before=%s\n' "$prepared_before"
printf 'prepared_transactions_after=%s\n' "$prepared_after"
printf 'direct_login_blocked=true\n'
printf 'control_socket_sql=%s\n' "$control_sql"
printf 'rows_at_fence=%s\n' "$rows_at_fence"
printf 'rows_after_release=%s\n' "$rows_after_release"
printf 'RESULT=PASS\n'
