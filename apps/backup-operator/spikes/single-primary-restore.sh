#!/usr/bin/env bash
set -euo pipefail

# Destructive single-primary PITR/rollback E2E. It accepts no input and creates
# only uniquely prefixed Docker resources.
prefix="backup-single-primary-$$"
image="${prefix}:local"
database="${prefix}-database"
restored="${prefix}-restored"
rolled_back="${prefix}-rolled-back"
data_volume="${prefix}-data"
repo_volume="${prefix}-repo"

cleanup() {
  docker rm -f "$database" "$restored" "$rolled_back" >/dev/null 2>&1 || true
  docker volume rm "$data_volume" "$repo_volume" >/dev/null 2>&1 || true
  docker image rm "$image" >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_postgres() {
  local container="$1"
  for _ in $(seq 1 120); do
    if docker exec "$container" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  docker logs "$container" >&2
  return 1
}

start_postgres() {
  local container="$1"
  docker run -d --name "$container" --user postgres \
    -v "$data_volume:/var/lib/postgresql" \
    -v "$repo_volume:/var/lib/pgbackrest" \
    --entrypoint postgres "$image" \
    -D /var/lib/postgresql/pgdata \
    -c listen_addresses='' \
    -c archive_mode=on \
    -c 'archive_command=pgbackrest --stanza=spike archive-push %p' >/dev/null
  wait_postgres "$container"
}

docker build -t "$image" ./spikes/patroni >/dev/null
docker volume create "$data_volume" >/dev/null
docker volume create "$repo_volume" >/dev/null
docker run --rm --user root -v "$data_volume:/var/lib/postgresql" -v "$repo_volume:/var/lib/pgbackrest" \
  --entrypoint chown "$image" -R postgres:postgres /var/lib/postgresql /var/lib/pgbackrest >/dev/null
docker run --rm --user postgres -v "$data_volume:/var/lib/postgresql" \
  --entrypoint initdb "$image" -D /var/lib/postgresql/pgdata --data-checksums >/dev/null

start_postgres "$database"
docker exec --user postgres "$database" pgbackrest --stanza=spike stanza-create >/dev/null
docker exec --user postgres "$database" pgbackrest --stanza=spike check >/dev/null
docker exec "$database" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c \
  "create table recovery_markers(id bigint primary key, value text not null); insert into recovery_markers values (1, 'before-target');" >/dev/null
docker exec --user postgres "$database" pgbackrest --stanza=spike --type=full backup >/dev/null
docker exec "$database" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c \
  "select pg_create_restore_point('single_primary_target'); insert into recovery_markers values (2, 'after-target'); select pg_switch_wal();" >/dev/null
docker exec --user postgres "$database" pgbackrest --stanza=spike check >/dev/null

# Failure injection: wrong stanza and missing repository must fail before PGDATA
# is touched.
if docker exec --user postgres "$database" pgbackrest --stanza=wrong-stanza check >/dev/null 2>&1; then
  echo "wrong stanza unexpectedly succeeded" >&2
  exit 1
fi
if docker run --rm --user postgres --entrypoint pgbackrest "$image" --stanza=spike check >/dev/null 2>&1; then
  echo "missing repository unexpectedly succeeded" >&2
  exit 1
fi

docker stop "$database" >/dev/null
docker run --rm --user postgres -v "$data_volume:/var/lib/postgresql" --entrypoint sh "$image" \
  -c 'mv /var/lib/postgresql/pgdata /var/lib/postgresql/pgdata.original' >/dev/null

# Mount the repository read-only for restore, preventing archive pollution on
# the pre-cutover timeline.
docker run --rm --user postgres -v "$data_volume:/var/lib/postgresql" -v "$repo_volume:/var/lib/pgbackrest:ro" \
  --entrypoint pgbackrest "$image" --stanza=spike --type=name \
  --target=single_primary_target --target-action=promote restore >/dev/null

start_postgres "$restored"
restored_rows="$(docker exec "$restored" psql -U postgres -d postgres -Atqc "select string_agg(value, ',' order by id) from recovery_markers")"
restored_system_id="$(docker exec "$restored" psql -U postgres -d postgres -Atqc "select system_identifier from pg_control_system()")"
test "$restored_rows" = "before-target"
docker exec --user postgres "$restored" pgbackrest --stanza=spike check >/dev/null

# Exercise the separate rollback path: quarantine the restored PGDATA and put
# the untouched original back in place.
docker stop "$restored" >/dev/null
docker run --rm --user postgres -v "$data_volume:/var/lib/postgresql" --entrypoint sh "$image" \
  -c 'mv /var/lib/postgresql/pgdata /var/lib/postgresql/pgdata.failed && mv /var/lib/postgresql/pgdata.original /var/lib/postgresql/pgdata' >/dev/null
start_postgres "$rolled_back"
rollback_rows="$(docker exec "$rolled_back" psql -U postgres -d postgres -Atqc "select string_agg(value, ',' order by id) from recovery_markers")"
rollback_system_id="$(docker exec "$rolled_back" psql -U postgres -d postgres -Atqc "select system_identifier from pg_control_system()")"
test "$rollback_rows" = "before-target,after-target"
test "$restored_system_id" = "$rollback_system_id"

printf 'named_target_rows=%s\n' "$restored_rows"
printf 'rollback_rows=%s\n' "$rollback_rows"
printf 'system_identifier=%s\n' "$restored_system_id"
printf 'wrong_stanza_rejected=true\n'
printf 'repository_outage_rejected=true\n'
printf 'repository_read_only_during_restore=true\n'
printf 'RESULT=PASS\n'
