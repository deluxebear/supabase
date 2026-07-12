#!/usr/bin/env bash
set -euo pipefail

# Destructive M0 Patroni spike. It creates only resources carrying this unique
# prefix and accepts no caller-controlled SQL, paths, container names, or args.
prefix="codex-patroni-spike-$$"
network="${prefix}-net"
etcd="${prefix}-etcd"
image="${prefix}-patroni:local"
repo_volume="${prefix}-repo"
password="patroni-spike-only"
nodes=("${prefix}-node1" "${prefix}-node2" "${prefix}-node3")
volumes=("${prefix}-data1" "${prefix}-data2" "${prefix}-data3")

cleanup() {
  docker rm -f "$etcd" "${nodes[@]}" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  docker volume rm "$repo_volume" "${volumes[@]}" >/dev/null 2>&1 || true
  docker image rm "$image" >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_http() {
  local container="$1"
  local path="$2"
  for _ in $(seq 1 120); do
    if docker exec "$container" curl -fsS "http://127.0.0.1:8008${path}" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  docker logs "$container" >&2
  return 1
}

leader_name() {
  docker exec "${nodes[0]}" curl -fsS http://127.0.0.1:8008/cluster \
    | jq -r '.members[] | select(.role == "leader") | .name'
}

container_for_member() {
  local member="$1"
  case "$member" in
    node1) printf '%s\n' "${nodes[0]}" ;;
    node2) printf '%s\n' "${nodes[1]}" ;;
    node3) printf '%s\n' "${nodes[2]}" ;;
    *) return 1 ;;
  esac
}

wait_cluster() {
  for _ in $(seq 1 180); do
    local cluster
    cluster="$(docker exec "${nodes[0]}" curl -fsS http://127.0.0.1:8008/cluster 2>/dev/null || true)"
    if [ "$(jq '[.members[] | select(.role == "leader")] | length' <<<"$cluster" 2>/dev/null || echo 0)" = "1" ] && \
      [ "$(jq '[.members[] | select(.role != "leader" and (.state == "running" or .state == "streaming"))] | length' <<<"$cluster" 2>/dev/null || echo 0)" = "2" ]; then
      return 0
    fi
    sleep 1
  done
  for node in "${nodes[@]}"; do docker logs "$node" >&2; done
  return 1
}

docker build -t "$image" ./spikes/patroni >/dev/null
docker network create "$network" >/dev/null
docker volume create "$repo_volume" >/dev/null
for volume in "${volumes[@]}"; do docker volume create "$volume" >/dev/null; done

docker run --rm -v "$repo_volume:/var/lib/pgbackrest" --entrypoint chown "$image" \
  -R postgres:postgres /var/lib/pgbackrest >/dev/null
for volume in "${volumes[@]}"; do
  docker run --rm -v "$volume:/var/lib/postgresql" --entrypoint chown "$image" \
    -R postgres:postgres /var/lib/postgresql >/dev/null
done

docker run -d --name "$etcd" --network "$network" --network-alias etcd \
  -e ETCD_UNSUPPORTED_ARCH=arm64 \
  quay.io/coreos/etcd:v3.5.21 \
  /usr/local/bin/etcd --name etcd \
  --listen-client-urls http://0.0.0.0:2379 \
  --advertise-client-urls http://etcd:2379 >/dev/null

for i in 0 1 2; do
  member="node$((i + 1))"
  docker run -d --user postgres --name "${nodes[$i]}" --hostname "$member" --network "$network" \
    -e PATRONI_SCOPE=spike \
    -e PATRONI_NAME="$member" \
    -e PATRONI_ETCD3_HOSTS="etcd:2379" \
    -e PATRONI_RESTAPI_LISTEN="0.0.0.0:8008" \
    -e PATRONI_RESTAPI_CONNECT_ADDRESS="$member:8008" \
    -e PATRONI_POSTGRESQL_LISTEN="0.0.0.0:5432" \
    -e PATRONI_POSTGRESQL_CONNECT_ADDRESS="$member:5432" \
    -e PATRONI_POSTGRESQL_DATA_DIR=/var/lib/postgresql/pgdata \
    -e PATRONI_POSTGRESQL_BIN_DIR=/usr/lib/postgresql/17/bin \
    -e PATRONI_POSTGRESQL_AUTHENTICATION_SUPERUSER_USERNAME=postgres \
    -e PATRONI_POSTGRESQL_AUTHENTICATION_SUPERUSER_PASSWORD="$password" \
    -e PATRONI_POSTGRESQL_AUTHENTICATION_REPLICATION_USERNAME=replicator \
    -e PATRONI_POSTGRESQL_AUTHENTICATION_REPLICATION_PASSWORD="$password" \
    -e PATRONI_BOOTSTRAP_INITDB='[{"encoding":"UTF8"},{"data-checksums":true}]' \
    -e PATRONI_BOOTSTRAP_DCS_TTL=30 \
    -e PATRONI_BOOTSTRAP_DCS_LOOP_WAIT=5 \
    -e PATRONI_BOOTSTRAP_DCS_RETRY_TIMEOUT=5 \
    -e PATRONI_BOOTSTRAP_DCS_SYNCHRONOUS_MODE=true \
    -e PATRONI_BOOTSTRAP_DCS_SYNCHRONOUS_MODE_STRICT=true \
    -e PATRONI_BOOTSTRAP_DCS_SYNCHRONOUS_NODE_COUNT=2 \
    -e PATRONI_BOOTSTRAP_DCS_POSTGRESQL_USE_PG_REWIND=true \
    -e PATRONI_BOOTSTRAP_DCS_POSTGRESQL_USE_SLOTS=true \
    -e PATRONI_BOOTSTRAP_DCS_POSTGRESQL_PARAMETERS_WAL_LOG_HINTS=on \
    -e PATRONI_BOOTSTRAP_DCS_POSTGRESQL_PARAMETERS_ARCHIVE_MODE=on \
    -e 'PATRONI_BOOTSTRAP_DCS_POSTGRESQL_PARAMETERS_ARCHIVE_COMMAND=pgbackrest --stanza=spike archive-push %p' \
    -e PATRONI_BOOTSTRAP_PG_HBA='["host replication replicator 0.0.0.0/0 scram-sha-256","host all all 0.0.0.0/0 scram-sha-256"]' \
    -v "${volumes[$i]}:/var/lib/postgresql" \
    -v "$repo_volume:/var/lib/pgbackrest" \
    "$image" >/dev/null
done

wait_http "${nodes[0]}" /cluster
wait_cluster

leader="$(leader_name)"
leader_container="$(container_for_member "$leader")"
initial_leader="$leader"

# Shared repository ownership is initialized once, then the active primary
# creates/checks the stanza. All SQL is hardcoded.
docker exec --user root "$leader_container" chown -R postgres:postgres /var/lib/pgbackrest
docker exec --user postgres "$leader_container" pgbackrest --stanza=spike stanza-create >/dev/null
docker exec --user postgres "$leader_container" pgbackrest --stanza=spike check >/dev/null

# Exercise asynchronous mode on the same real cluster, then restore strict
# synchronous mode before creating the recovery fixture.
docker exec "$leader_container" curl -fsS -X PATCH -H 'Content-Type: application/json' \
  -d '{"synchronous_mode":false,"synchronous_mode_strict":false}' http://127.0.0.1:8008/config >/dev/null
sleep 6
async_mode="$(docker exec "$leader_container" curl -fsS http://127.0.0.1:8008/config | jq -r '.synchronous_mode')"
test "$async_mode" = "false"
docker exec "$leader_container" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c \
  "create table async_replication_probe(id integer primary key); insert into async_replication_probe values (1);" >/dev/null
docker exec "$leader_container" curl -fsS -X PATCH -H 'Content-Type: application/json' \
  -d '{"synchronous_mode":true,"synchronous_mode_strict":true,"synchronous_node_count":2}' http://127.0.0.1:8008/config >/dev/null
sleep 8
synchronous_mode="$(docker exec "$leader_container" curl -fsS http://127.0.0.1:8008/config | jq -r '.synchronous_mode')"
test "$synchronous_mode" = "true"

docker exec "$leader_container" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c \
  "create table recovery_markers(id bigint primary key, value text not null); insert into recovery_markers values (1, 'before-target');" >/dev/null
docker exec --user postgres "$leader_container" pgbackrest --stanza=spike --type=full backup >/dev/null
docker exec "$leader_container" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c \
  "select pg_create_restore_point('patroni_spike_target'); insert into recovery_markers values (2, 'after-target'); select pg_switch_wal();" >/dev/null
docker exec --user postgres "$leader_container" pgbackrest --stanza=spike check >/dev/null

sync_names="$(docker exec "$leader_container" psql -U postgres -d postgres -Atqc "show synchronous_standby_names")"
sync_count="$(docker exec "$leader_container" psql -U postgres -d postgres -Atqc "select count(*) from pg_stat_replication where sync_state in ('sync','quorum')")"
test "$sync_count" -ge 1

# Patroni pause is coordination, not fencing. The spike records that a manual
# switchover remains accepted while paused.
docker exec "$leader_container" curl -fsS -X PATCH -H 'Content-Type: application/json' \
  -d '{"pause":true}' http://127.0.0.1:8008/config >/dev/null
sleep 6
pause_state="$(docker exec "$leader_container" curl -fsS http://127.0.0.1:8008/config | jq -r '.pause')"
test "$pause_state" = "true"

candidate="$(docker exec "$leader_container" curl -fsS http://127.0.0.1:8008/cluster \
  | jq -r '.members[] | select(.role != "leader") | .name' | head -1)"
switchover_code="$(docker exec "$leader_container" curl -sS -o /tmp/switchover.out -w '%{http_code}' \
  -X POST -H 'Content-Type: application/json' \
  -d "{\"leader\":\"$leader\",\"candidate\":\"$candidate\"}" \
  http://127.0.0.1:8008/switchover)"
case "$switchover_code" in 200|202) ;; *) docker exec "$leader_container" cat /tmp/switchover.out >&2; exit 1 ;; esac
sleep 8
leader="$(leader_name)"
leader_container="$(container_for_member "$leader")"
post_switchover_leader="$leader"

# A DCS outage while paused leaves PostgreSQL running but removes the ability
# to coordinate/resume. Record both facts, then restore DCS before PITR.
docker stop "$etcd" >/dev/null
sleep 7
dcs_outage_sql="$(docker exec "$leader_container" psql -U postgres -d postgres -Atqc "select 1")"
test "$dcs_outage_sql" = "1"
docker start "$etcd" >/dev/null
sleep 7

# No clients remain after this point. Stop every Patroni node, restore the
# current leader to the named target, then rebuild both old replicas from empty
# data directories so no pre-PITR replica can rejoin the new timeline.
for node in "${nodes[@]}"; do docker stop "$node" >/dev/null; done

docker run --rm --volumes-from "$leader_container" --entrypoint sh "$image" \
  -c 'rm -rf /var/lib/postgresql/pgdata' >/dev/null
docker run --rm --volumes-from "$leader_container" --user postgres \
  --entrypoint pgbackrest "$image" --stanza=spike \
  --type=name --target=patroni_spike_target --target-action=promote restore >/dev/null

leader_index=0
for i in 0 1 2; do
  if [ "${nodes[$i]}" = "$leader_container" ]; then leader_index="$i"; fi
done

for i in 0 1 2; do
  if [ "$i" -ne "$leader_index" ]; then
    docker run --rm -v "${volumes[$i]}:/var/lib/postgresql" --entrypoint sh "$image" \
      -c 'rm -rf /var/lib/postgresql/pgdata' >/dev/null
  fi
done

docker start "$leader_container" >/dev/null
wait_http "$leader_container" /patroni
docker exec "$leader_container" /usr/lib/postgresql/17/bin/pg_ctl \
  -D /var/lib/postgresql/pgdata -w start >/dev/null 2>&1 || true

for i in 0 1 2; do
  if [ "$i" -ne "$leader_index" ]; then docker start "${nodes[$i]}" >/dev/null; fi
done

docker exec "$leader_container" curl -fsS -X PATCH -H 'Content-Type: application/json' \
  -d '{"pause":false}' http://127.0.0.1:8008/config >/dev/null
wait_cluster

leader="$(leader_name)"
leader_container="$(container_for_member "$leader")"
target_rows="$(docker exec "$leader_container" psql -U postgres -d postgres -Atqc "select string_agg(value, ',' order by id) from recovery_markers")"
replica_count="$(docker exec "$leader_container" psql -U postgres -d postgres -Atqc "select count(*) from pg_stat_replication")"
timeline="$(docker exec "$leader_container" psql -U postgres -d postgres -Atqc "select timeline_id from pg_control_checkpoint()")"

test "$target_rows" = "before-target"
test "$replica_count" = "2"

printf 'initial_leader=%s\n' "$initial_leader"
printf 'post_switchover_leader=%s\n' "$post_switchover_leader"
printf 'pause_state=%s\n' "$pause_state"
printf 'paused_switchover_http=%s\n' "$switchover_code"
printf 'dcs_outage_primary_sql=%s\n' "$dcs_outage_sql"
printf 'synchronous_standby_names=%s\n' "$sync_names"
printf 'asynchronous_mode_exercised=%s\n' "$async_mode"
printf 'synchronous_mode_restored=%s\n' "$synchronous_mode"
printf 'target_after_pitr=%s\n' "$target_rows"
printf 'rebuilt_replicas=%s\n' "$replica_count"
printf 'restored_timeline=%s\n' "$timeline"
printf 'RESULT=PASS\n'
