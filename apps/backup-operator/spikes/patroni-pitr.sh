#!/usr/bin/env bash
set -Eeuo pipefail

# Destructive M0 Patroni spike. It creates only resources carrying this unique
# prefix and accepts no caller-controlled SQL, paths, container names, or args.
pitr_mode="${PITR_MODE:-name}"
case "$pitr_mode" in name|time) ;; *) echo "PITR_MODE must be name or time" >&2; exit 2 ;; esac
preflight_only="${PREFLIGHT_ONLY:-0}"
case "$preflight_only" in 0|1) ;; *) echo "PREFLIGHT_ONLY must be 0 or 1" >&2; exit 2 ;; esac
evidence_file="${EVIDENCE_FILE:-$(pwd)/patroni-${pitr_mode}-evidence.json}"
prefix="codex-patroni-${pitr_mode}-spike-$$"
network="${prefix}-net"
etcd="${prefix}-etcd"
isolated_container="${prefix}-isolated-recovery"
image="${prefix}-patroni:local"
repo_volume="${prefix}-repo"
password="patroni-spike-only"
nodes=("${prefix}-node1" "${prefix}-node2" "${prefix}-node3")
volumes=("${prefix}-data1" "${prefix}-data2" "${prefix}-data3")
phase="initializing"
failure_message=""
dcs_leader_before_response='{"count":0,"kvs":[]}'
dcs_leader_before_handback=""
dcs_history_before_response='{"count":0,"kvs":[]}'
dcs_history_before_handback=""
dcs_leader_after_response='{"count":0,"kvs":[]}'
dcs_leader_after_handback=""
dcs_history_after_response='{"count":0,"kvs":[]}'
dcs_history_after_handback=""
restore_signal_verified="false"
restore_target_action_verified="false"
restore_target_selector_verified="false"
standby_residue_absent="false"
target_lsn=""
target_wal_segment=""
configured_restore_command=""
archive_get_diagnostic=""
archive_get_rc=""
archive_get_bytes=""
restart_code=""
isolated_recovery_log=""
patroni_handback_log=""
promoted_data_dir_verified="false"
admission_original_present="false"
admission_original_value="1048576"
admission_override_value="1099511627776"
admission_override_applied="false"
admission_restored="false"

restore_admission_best_effort() {
  set +e
  if [ "$admission_override_applied" = "true" ] && [ -n "${leader_container:-}" ] && \
      docker inspect "$leader_container" >/dev/null 2>&1; then
    if [ "$admission_original_present" = "true" ]; then
      admission_restore_payload="$(jq -cn --argjson value "$admission_original_value" \
        '{maximum_lag_on_failover:$value}')"
    else
      admission_restore_payload='{"maximum_lag_on_failover":null}'
    fi
    if docker exec "$leader_container" curl -fsS -X PATCH -H 'Content-Type: application/json' \
        -d "$admission_restore_payload" http://127.0.0.1:8008/config >/dev/null 2>&1; then
      admission_restored="true"
      admission_override_applied="false"
    fi
  fi
  if [ -n "${leader_container:-}" ] && docker inspect "$leader_container" >/dev/null 2>&1; then
    docker exec "$leader_container" curl -fsS -X PATCH -H 'Content-Type: application/json' \
      -d '{"pause":true}' http://127.0.0.1:8008/config >/dev/null 2>&1 || true
  fi
}

collect_runtime_logs() {
  set +e
  if docker inspect "$isolated_container" >/dev/null 2>&1; then
    isolated_recovery_log="$(docker logs --tail 400 "$isolated_container" 2>&1)"
  fi
  if [ -n "${leader_container:-}" ] && docker inspect "$leader_container" >/dev/null 2>&1; then
    patroni_handback_log="$(docker logs --tail 400 "$leader_container" 2>&1)"
  fi
}

write_failure_evidence() {
  local rc="$1"
  local line="$2"
  local command="$3"
  local leader_before_json history_before_json leader_after_json history_after_json
  set +e
  collect_runtime_logs
  leader_before_json="$(json_for_evidence "$dcs_leader_before_response")"
  history_before_json="$(json_for_evidence "$dcs_history_before_response")"
  leader_after_json="$(json_for_evidence "$dcs_leader_after_response")"
  history_after_json="$(json_for_evidence "$dcs_history_after_response")"
  mkdir -p "$(dirname "$evidence_file")"
  jq -n \
    --arg mode "$pitr_mode" --arg phase "$phase" --arg message "$failure_message" \
    --arg command "$command" --argjson rc "$rc" --argjson line "$line" \
    --arg expectedLeader "${leader:-}" \
    --arg restoreSignal "$restore_signal_verified" --arg restoreAction "$restore_target_action_verified" \
    --arg restoreTarget "$restore_target_selector_verified" \
    --arg standbyResidueAbsent "$standby_residue_absent" \
    --arg targetLSN "$target_lsn" --arg targetWALSegment "$target_wal_segment" \
    --arg restoreCommand "$configured_restore_command" --arg archiveGetDiagnostic "$archive_get_diagnostic" \
    --arg archiveGetRC "$archive_get_rc" --arg archiveGetBytes "$archive_get_bytes" --arg restartHTTP "$restart_code" \
    --arg isolatedLog "$isolated_recovery_log" --arg patroniLog "$patroni_handback_log" \
    --arg promotedDataDir "$promoted_data_dir_verified" \
    --arg admissionOriginalPresent "$admission_original_present" --arg admissionOriginalValue "$admission_original_value" \
    --arg admissionOverrideValue "$admission_override_value" --arg admissionOverrideApplied "$admission_override_applied" \
    --arg admissionRestored "$admission_restored" \
    --arg leaderBefore "$dcs_leader_before_handback" \
    --argjson leaderBeforeResponse "$leader_before_json" \
    --arg historyBefore "$dcs_history_before_handback" \
    --argjson historyBeforeResponse "$history_before_json" \
    --arg leaderAfter "$dcs_leader_after_handback" \
    --argjson leaderAfterResponse "$leader_after_json" \
    --arg historyAfter "$dcs_history_after_handback" \
    --argjson historyAfterResponse "$history_after_json" \
    '{schemaVersion:1,result:"FAIL",pitrMode:$mode,phase:$phase,error:{exitCode:$rc,line:$line,command:$command,message:$message},
      expectedRecoveredLeader:$expectedLeader,
      restorePreflight:{recoverySignalVerified:($restoreSignal=="true"),
        targetActionPromoteVerified:($restoreAction=="true"),targetSelectorVerified:($restoreTarget=="true"),
        standbyResidueAbsent:($standbyResidueAbsent=="true"),targetLSN:$targetLSN,
        targetWALSegment:$targetWALSegment,configuredRestoreCommand:$restoreCommand,
        archiveGet:{exitCode:$archiveGetRC,bytes:$archiveGetBytes,diagnostic:$archiveGetDiagnostic},
        patroniRestartHTTP:$restartHTTP,promotedDataDirVerified:($promotedDataDir=="true")},
      leaderAdmission:{originalPresent:($admissionOriginalPresent=="true"),originalValue:$admissionOriginalValue,
        overrideValue:$admissionOverrideValue,overrideStillApplied:($admissionOverrideApplied=="true"),
        restored:($admissionRestored=="true")},
      logs:{isolatedRecovery:$isolatedLog,patroniHandback:$patroniLog},
      dcsObserved:{beforeHandback:{leaderDecoded:$leaderBefore,leaderResponse:$leaderBeforeResponse,
        historyDecoded:$historyBefore,historyResponse:$historyBeforeResponse},
        afterHandback:{leaderDecoded:$leaderAfter,leaderResponse:$leaderAfterResponse,
        historyDecoded:$historyAfter,historyResponse:$historyAfterResponse}}}' >"$evidence_file"
}

handle_error() {
  local rc="$1"
  local line="$2"
  local command="$3"
  trap - ERR
  restore_admission_best_effort
  write_failure_evidence "$rc" "$line" "$command"
  echo "ERROR phase=$phase line=$line rc=$rc command=$command" >&2
  exit "$rc"
}

fail() {
  failure_message="$1"
  return 1
}

json_for_evidence() {
  local candidate="$1"
  if [ -n "$candidate" ] && jq -e . >/dev/null 2>&1 <<<"$candidate"; then
    printf '%s\n' "$candidate"
  else
    jq -cn --arg raw "$candidate" '{invalidOrEmptyResponse:$raw}'
  fi
}

read_etcd_key_response() {
  local path="$1"
  docker exec -e ETCDCTL_API=3 "$etcd" etcdctl get "$path" -w json
}

decode_etcd_single_value() {
  jq -er '
    if (.count // 0) == 0 then ""
    elif .count == 1 then (.kvs[0].value | @base64d)
    else error("expected exactly zero or one key")
    end
  '
}

write_handback_checkpoint() {
  set +e
  mkdir -p "$(dirname "$evidence_file")"
  jq -n \
    --arg mode "$pitr_mode" --arg phase "$phase" --arg expectedLeader "$leader" \
    --arg leaderDecoded "$dcs_leader_before_handback" \
    --argjson leaderResponse "$dcs_leader_before_response" \
    --arg historyDecoded "$dcs_history_before_handback" \
    --argjson historyResponse "$dcs_history_before_response" \
    '{schemaVersion:1,result:"IN_PROGRESS",pitrMode:$mode,phase:$phase,expectedRecoveredLeader:$expectedLeader,
      dcsObserved:{leaderDecoded:$leaderDecoded,leaderResponse:$leaderResponse,
        historyDecoded:$historyDecoded,historyResponse:$historyResponse}}' >"$evidence_file"
  set -e
}

cleanup() {
  docker rm -f "$isolated_container" "$etcd" "${nodes[@]}" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  docker volume rm "$repo_volume" "${volumes[@]}" >/dev/null 2>&1 || true
  docker image rm "$image" >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'handle_error "$?" "$LINENO" "$BASH_COMMAND"' ERR

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

wait_sql_primary() {
  local container="$1"
  for _ in $(seq 1 180); do
    if [ "$(docker exec "$container" psql -U postgres -d postgres -Atqc \
      "select not pg_is_in_recovery()" 2>/dev/null || true)" = "t" ]; then
      return 0
    fi
    sleep 1
  done
  docker logs "$container" >&2
  return 1
}

leader_name() {
  local cluster leader
  for _ in $(seq 1 60); do
    for node in "${nodes[@]}"; do
      cluster="$(docker exec "$node" curl -fsS http://127.0.0.1:8008/cluster 2>/dev/null || true)"
      leader="$(jq -r '.members[]? | select(.role == "leader") | .name' <<<"$cluster" | head -1)"
      if [ -n "$leader" ]; then printf '%s\n' "$leader"; return 0; fi
    done
    sleep 1
  done
  return 1
}

wait_leader_converged() {
  local expected="$1"
  local cluster_leader dcs_response dcs_leader
  for _ in $(seq 1 90); do
    cluster_leader="$(leader_name 2>/dev/null || true)"
    dcs_response="$(read_etcd_key_response /service/spike/leader 2>/dev/null || true)"
    dcs_leader="$(decode_etcd_single_value <<<"$dcs_response" 2>/dev/null || true)"
    if [ "$cluster_leader" = "$expected" ] && [ "$dcs_leader" = "$expected" ]; then
      return 0
    fi
    sleep 1
  done
  return 1
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
    if [ "$(jq '[.members[] | select(.role == "leader" and .state == "running")] | length' <<<"$cluster" 2>/dev/null || echo 0)" = "1" ] && \
      [ "$(jq '[.members[] | select(.role != "leader" and (.state == "running" or .state == "streaming"))] | length' <<<"$cluster" 2>/dev/null || echo 0)" = "2" ]; then
      return 0
    fi
    sleep 1
  done
  for node in "${nodes[@]}"; do docker logs "$node" >&2; done
  return 1
}

phase="building-test-environment"
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
initial_config_json="$(docker exec "$leader_container" curl -fsS http://127.0.0.1:8008/config)"
if jq -e 'has("maximum_lag_on_failover")' >/dev/null <<<"$initial_config_json"; then
  admission_original_present="true"
  admission_original_value="$(jq -er '.maximum_lag_on_failover | numbers' <<<"$initial_config_json")"
fi

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
target_fixture="$(docker exec "$leader_container" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -AtF '|' -c \
  "select lsn, pg_walfile_name(lsn) from (select pg_create_restore_point('patroni_spike_target') as lsn) target;")"
IFS='|' read -r target_lsn target_wal_segment <<<"$target_fixture"
test -n "$target_lsn"
test -n "$target_wal_segment"
target_time="$(docker exec "$leader_container" psql -U postgres -d postgres -Atqc "select clock_timestamp()")"
sleep 2
docker exec "$leader_container" psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c \
  "insert into recovery_markers values (2, 'after-target'); select pg_switch_wal();" >/dev/null
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
external_write_fence="isolated-test-network-with-no-client-containers"

if [ "$leader" != "node2" ]; then
  candidate="node2"
else
  candidate="$(docker exec "$leader_container" curl -fsS http://127.0.0.1:8008/cluster \
    | jq -r '.members[] | select(.role != "leader") | .name' | head -1)"
fi
switchover_code="$(docker exec "$leader_container" curl -sS -o /tmp/switchover.out -w '%{http_code}' \
  -X POST -H 'Content-Type: application/json' \
  -d "{\"leader\":\"$leader\",\"candidate\":\"$candidate\"}" \
  http://127.0.0.1:8008/switchover || true)"
case "$switchover_code" in
  200|202|000) wait_leader_converged "$candidate" ;;
  *) docker exec "$(container_for_member "$initial_leader")" cat /tmp/switchover.out >&2 || true; exit 1 ;;
esac
leader="$candidate"
leader_container="$(container_for_member "$leader")"
post_switchover_leader="$leader"

# The old leader is now a known standby. Record it before making DCS and the
# Patroni cluster endpoint intentionally unavailable.
rogue="$initial_leader"
rogue_container="$(container_for_member "$rogue")"

# A DCS outage while paused leaves PostgreSQL running but removes the ability
# to coordinate/resume. Record both facts, then restore DCS before PITR.
docker stop "$etcd" >/dev/null
sleep 7
dcs_outage_sql="$(docker exec "$leader_container" psql -U postgres -d postgres -Atqc "select 1")"
test "$dcs_outage_sql" = "1"

# Deliberately create a second writable PostgreSQL while DCS is unavailable.
# A safe recovery admission check must reject any writable-primary count other
# than one. The rogue node is stopped immediately and never allowed to archive.
docker exec "$rogue_container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c \
  "alter system set archive_command='false'" >/dev/null
docker exec "$rogue_container" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c \
  "select pg_reload_conf()" >/dev/null
docker exec "$rogue_container" /usr/lib/postgresql/17/bin/pg_ctl \
  -D /var/lib/postgresql/pgdata -w promote >/dev/null
sleep 2
writable_primaries=0
for node in "$leader_container" "$rogue_container"; do
  writable="$(docker exec "$node" psql -U postgres -d postgres -Atqc "select not pg_is_in_recovery()")"
  if [ "$writable" = "t" ]; then writable_primaries=$((writable_primaries + 1)); fi
done
test "$writable_primaries" = "2"
dual_primary_fail_closed="false"
if [ "$writable_primaries" -ne 1 ]; then dual_primary_fail_closed="true"; fi
test "$dual_primary_fail_closed" = "true"
docker stop "$rogue_container" >/dev/null
docker start "$etcd" >/dev/null
sleep 7

# No clients remain after this point. Stop every Patroni node and require the
# old leased leader key to disappear naturally before restoring anything. A
# matching member name still belongs to the stopped process's old lease and is
# never accepted as current ownership.
for node in "${nodes[@]}"; do docker stop "$node" >/dev/null; done

phase="waiting-for-stale-leader-lease-expiry"
dcs_history_before_response="$(read_etcd_key_response /service/spike/history)"
dcs_history_before_handback="$(decode_etcd_single_value <<<"$dcs_history_before_response")"
for _ in $(seq 0 45); do
  dcs_leader_before_response="$(read_etcd_key_response /service/spike/leader)"
  dcs_leader_before_handback="$(decode_etcd_single_value <<<"$dcs_leader_before_response")"
  write_handback_checkpoint
  if [ -z "$dcs_leader_before_handback" ]; then
    break
  fi
  case "$dcs_leader_before_handback" in
    node1|node2|node3) sleep 1 ;;
    *) fail "DCS leader value is not a Patroni member name: $dcs_leader_before_handback" ;;
  esac
done
if [ -n "$dcs_leader_before_handback" ]; then
  fail "stale DCS leader lease for $dcs_leader_before_handback did not expire after all Patroni processes stopped"
fi

phase="restoring-primary"
docker run --rm --volumes-from "$leader_container" --entrypoint sh "$image" \
  -c 'rm -rf /var/lib/postgresql/pgdata' >/dev/null
restore_target=(--type=name --target=patroni_spike_target)
if [ "$pitr_mode" = "time" ]; then
  restore_target=(--type=time --target="$target_time")
fi
docker run --rm --volumes-from "$leader_container" --user postgres \
  --entrypoint pgbackrest "$image" --stanza=spike \
  "${restore_target[@]}" --target-action=promote restore >/dev/null

# pgBackRest must leave a finite PITR recovery, never standby recovery. Keep
# recovery.signal and restore_command for PostgreSQL to reach the named target,
# but reject standby.signal and upstream-following parameters inherited from a
# former replica before Patroni is allowed to start.
phase="validating-restore-preflight"
docker run --rm --volumes-from "$leader_container" --entrypoint sh "$image" -ec '
  data=/var/lib/postgresql/pgdata
  test -f "$data/recovery.signal"
  test ! -e "$data/standby.signal"
  grep -Eq "^[[:space:]]*recovery_target_action[[:space:]]*=[[:space:]]*'"'"'promote'"'"'" "$data/postgresql.auto.conf"
  if grep -Eh "^[[:space:]]*(primary_conninfo|primary_slot_name)[[:space:]]*=" \
      "$data/postgresql.auto.conf" "$data/postgresql.conf" 2>/dev/null | grep -q .; then
    exit 1
  fi
' >/dev/null
restore_signal_verified="true"
restore_target_action_verified="true"
standby_residue_absent="true"
if [ "$pitr_mode" = "name" ]; then
  docker run --rm --volumes-from "$leader_container" --entrypoint grep "$image" \
    -Eq "^[[:space:]]*recovery_target_name[[:space:]]*=[[:space:]]*'patroni_spike_target'" \
    /var/lib/postgresql/pgdata/postgresql.auto.conf
else
  docker run --rm --volumes-from "$leader_container" --entrypoint grep "$image" \
    -Eq "^[[:space:]]*recovery_target_time[[:space:]]*=" \
    /var/lib/postgresql/pgdata/postgresql.auto.conf
fi
restore_target_selector_verified="true"

# Validate the exact WAL retrieval path PostgreSQL will use before Patroni is
# allowed to touch the restored data directory. The configured command is
# observed via postgres -C; execution remains an explicit fixed argv command,
# never eval of configuration text.
phase="validating-target-wal-archive-get"
configured_restore_command="$(docker run --rm --volumes-from "$leader_container" --user postgres \
  --entrypoint postgres "$image" -D /var/lib/postgresql/pgdata -C restore_command)"
case "$configured_restore_command" in
  *pgbackrest*--stanza=spike*archive-get*%f*%p*) ;;
  *) fail "unexpected restore_command: $configured_restore_command" ;;
esac
set +e
archive_get_diagnostic="$(docker run --rm --volumes-from "$leader_container" --user postgres \
  --entrypoint sh "$image" -c '
    destination="/tmp/$1"
    pgbackrest --stanza=spike archive-get "$1" "$destination" 2>&1
    rc=$?
    if [ "$rc" -eq 0 ]; then wc -c <"$destination"; fi
    exit "$rc"
  ' sh "$target_wal_segment" 2>&1)"
archive_get_rc="$?"
set -e
if [ "$archive_get_rc" -ne 0 ]; then
  fail "archive-get failed for target WAL $target_wal_segment: $archive_get_diagnostic"
fi
archive_get_bytes="$(tail -n 1 <<<"$archive_get_diagnostic" | tr -d '[:space:]')"
case "$archive_get_bytes" in
  ''|*[!0-9]*) fail "archive-get did not report a numeric byte size: $archive_get_diagnostic" ;;
esac
test "$archive_get_bytes" -gt 0

if [ "$preflight_only" = "1" ]; then
  phase="wal-preflight-complete"
  mkdir -p "$(dirname "$evidence_file")"
  jq -n --arg mode "$pitr_mode" --arg targetLSN "$target_lsn" --arg targetWALSegment "$target_wal_segment" \
    --arg restoreCommand "$configured_restore_command" --arg diagnostic "$archive_get_diagnostic" \
    --argjson archiveGetRC "$archive_get_rc" --argjson archiveGetBytes "$archive_get_bytes" \
    '{schemaVersion:1,result:"PASS_DIAGNOSTIC",pitrMode:$mode,targetLSN:$targetLSN,
      targetWALSegment:$targetWALSegment,configuredRestoreCommand:$restoreCommand,
      archiveGet:{exitCode:$archiveGetRC,bytes:$archiveGetBytes,diagnostic:$diagnostic}}' >"$evidence_file"
  printf 'evidence=%s\n' "$evidence_file"
  printf 'RESULT=PASS_DIAGNOSTIC\n'
  exit 0
fi

# Run finite PITR as an isolated PostgreSQL process while Patroni remains
# stopped, the cluster remains paused, and the external fence remains engaged.
# This is recovery/validation only: the isolated process is cleanly stopped
# before Patroni is allowed to own the final primary process.
phase="running-isolated-finite-recovery"
docker run -d --name "$isolated_container" --hostname isolated-recovery --network "$network" \
  --user postgres --volumes-from "$leader_container" --entrypoint postgres "$image" \
  -D /var/lib/postgresql/pgdata >/dev/null
wait_sql_primary "$isolated_container"
isolated_target_rows="$(docker exec "$isolated_container" psql -U postgres -d postgres -Atqc \
  "select string_agg(value, ',' order by id) from recovery_markers")"
test "$isolated_target_rows" = "before-target"
isolated_recovery_log="$(docker logs --tail 400 "$isolated_container" 2>&1)"
docker stop -t 30 "$isolated_container" >/dev/null

phase="validating-promoted-data-directory"
docker run --rm --volumes-from "$leader_container" --entrypoint sh "$image" -ec '
  data=/var/lib/postgresql/pgdata
  test ! -e "$data/recovery.signal"
  test ! -e "$data/standby.signal"
' >/dev/null
control_data="$(docker run --rm --volumes-from "$leader_container" --user postgres \
  --entrypoint /usr/lib/postgresql/17/bin/pg_controldata "$image" /var/lib/postgresql/pgdata)"
grep -Eq '^Database cluster state:[[:space:]]+shut down' <<<"$control_data"
promoted_data_dir_verified="true"
docker rm "$isolated_container" >/dev/null

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

phase="starting-patroni-control"
docker start "$leader_container" >/dev/null
wait_http "$leader_container" /patroni

# A deliberate PITR rewind is expected to be behind Patroni's pre-recovery
# status LSN. Temporarily relax only the leader-race lag admission while the
# external fence remains engaged and this is the sole running database node.
phase="relaxing-intentional-rewind-admission"
admission_override_payload="$(jq -cn --argjson value "$admission_override_value" \
  '{maximum_lag_on_failover:$value}')"
docker exec "$leader_container" curl -fsS -X PATCH -H 'Content-Type: application/json' \
  -d "$admission_override_payload" http://127.0.0.1:8008/config >/dev/null
admission_override_applied="true"
admission_observed="$(docker exec "$leader_container" curl -fsS http://127.0.0.1:8008/config \
  | jq -er '.maximum_lag_on_failover | numbers')"
test "$admission_observed" = "$admission_override_value"

phase="resuming-patroni-handback"
docker exec "$leader_container" curl -fsS -X PATCH -H 'Content-Type: application/json' \
  -d '{"pause":false,"synchronous_mode":true,"synchronous_mode_strict":true,"synchronous_node_count":2}' \
  http://127.0.0.1:8008/config >/dev/null
wait_http "$leader_container" /primary

phase="restoring-leader-admission"
if [ "$admission_original_present" = "true" ]; then
  admission_restore_payload="$(jq -cn --argjson value "$admission_original_value" \
    '{maximum_lag_on_failover:$value}')"
else
  admission_restore_payload='{"maximum_lag_on_failover":null}'
fi
docker exec "$leader_container" curl -fsS -X PATCH -H 'Content-Type: application/json' \
  -d "$admission_restore_payload" http://127.0.0.1:8008/config >/dev/null
restored_admission_config="$(docker exec "$leader_container" curl -fsS http://127.0.0.1:8008/config)"
if [ "$admission_original_present" = "true" ]; then
  test "$(jq -er '.maximum_lag_on_failover | numbers' <<<"$restored_admission_config")" = "$admission_original_value"
else
  jq -e 'has("maximum_lag_on_failover") | not' >/dev/null <<<"$restored_admission_config"
fi
admission_restored="true"
admission_override_applied="false"

phase="rebuilding-standbys"
for i in 0 1 2; do
  if [ "$i" -ne "$leader_index" ]; then docker start "${nodes[$i]}" >/dev/null; fi
done
wait_cluster

leader="$(leader_name)"
leader_container="$(container_for_member "$leader")"
target_rows="$(docker exec "$leader_container" psql -U postgres -d postgres -Atqc "select string_agg(value, ',' order by id) from recovery_markers")"
replica_count="$(docker exec "$leader_container" psql -U postgres -d postgres -Atqc "select count(*) from pg_stat_replication")"
timeline="$(docker exec "$leader_container" psql -U postgres -d postgres -Atqc "select timeline_id from pg_control_checkpoint()")"
phase="validating-restored-cluster"
dcs_leader_after_response="$(read_etcd_key_response /service/spike/leader)"
dcs_leader_after_handback="$(decode_etcd_single_value <<<"$dcs_leader_after_response")"
dcs_history_after_response="$(read_etcd_key_response /service/spike/history)"
dcs_history_after_handback="$(decode_etcd_single_value <<<"$dcs_history_after_response")"

test "$target_rows" = "before-target"
test "$replica_count" = "2"
test "$dcs_leader_after_handback" = "$leader"
test -n "$dcs_history_after_handback"

printf 'initial_leader=%s\n' "$initial_leader"
printf 'post_switchover_leader=%s\n' "$post_switchover_leader"
printf 'pause_state=%s\n' "$pause_state"
printf 'paused_switchover_http=%s\n' "$switchover_code"
printf 'dcs_outage_primary_sql=%s\n' "$dcs_outage_sql"
printf 'dual_primary_writable_count=%s\n' "$writable_primaries"
printf 'dual_primary_fail_closed=%s\n' "$dual_primary_fail_closed"
printf 'synchronous_standby_names=%s\n' "$sync_names"
printf 'asynchronous_mode_exercised=%s\n' "$([[ "$async_mode" == "false" ]] && printf true || printf false)"
printf 'synchronous_mode_restored=%s\n' "$synchronous_mode"
printf 'target_after_pitr=%s\n' "$target_rows"
printf 'rebuilt_replicas=%s\n' "$replica_count"
printf 'restored_timeline=%s\n' "$timeline"
archive_check="$(docker exec --user postgres "$leader_container" pgbackrest --stanza=spike check >/dev/null && echo healthy)"
cluster_json="$(docker exec "$leader_container" curl -fsS http://127.0.0.1:8008/cluster)"
collect_runtime_logs
mkdir -p "$(dirname "$evidence_file")"
jq -n \
  --arg mode "$pitr_mode" --arg initialLeader "$initial_leader" --arg postSwitchoverLeader "$post_switchover_leader" \
  --arg pause "$pause_state" --arg switchoverHTTP "$switchover_code" --arg dcsSQL "$dcs_outage_sql" \
  --argjson writablePrimaries "$writable_primaries" --argjson dualPrimaryFailClosed "$dual_primary_fail_closed" \
  --arg asyncMode "$async_mode" --arg syncMode "$synchronous_mode" --arg syncNames "$sync_names" \
  --arg targetTime "$target_time" --arg rows "$target_rows" --argjson replicas "$replica_count" \
  --argjson timeline "$timeline" --arg archive "$archive_check" --argjson cluster "$cluster_json" \
  --arg restoreSignal "$restore_signal_verified" --arg restoreAction "$restore_target_action_verified" \
  --arg restoreTarget "$restore_target_selector_verified" \
  --arg standbyResidueAbsent "$standby_residue_absent" \
  --arg targetLSN "$target_lsn" --arg targetWALSegment "$target_wal_segment" \
  --arg restoreCommand "$configured_restore_command" --arg archiveGetDiagnostic "$archive_get_diagnostic" \
  --arg archiveGetRC "$archive_get_rc" --arg archiveGetBytes "$archive_get_bytes" --arg restartHTTP "$restart_code" \
  --arg isolatedLog "$isolated_recovery_log" --arg patroniLog "$patroni_handback_log" \
  --arg promotedDataDir "$promoted_data_dir_verified" \
  --arg admissionOriginalPresent "$admission_original_present" --arg admissionOriginalValue "$admission_original_value" \
  --arg admissionOverrideValue "$admission_override_value" --arg admissionOverrideApplied "$admission_override_applied" \
  --arg admissionRestored "$admission_restored" \
  --arg fence "$external_write_fence" --arg dcsLeaderBefore "$dcs_leader_before_handback" \
  --argjson dcsLeaderBeforeResponse "$dcs_leader_before_response" \
  --arg dcsHistoryBefore "$dcs_history_before_handback" --arg dcsLeaderAfter "$dcs_leader_after_handback" \
  --argjson dcsHistoryBeforeResponse "$dcs_history_before_response" \
  --argjson dcsLeaderAfterResponse "$dcs_leader_after_response" \
  --arg dcsHistoryAfter "$dcs_history_after_handback" \
  --argjson dcsHistoryAfterResponse "$dcs_history_after_response" \
  '{schemaVersion:1,result:"PASS",pitrMode:$mode,initialLeader:$initialLeader,postSwitchoverLeader:$postSwitchoverLeader,
    pauseObserved:($pause=="true"),pausedSwitchoverHTTP:$switchoverHTTP,dcsOutagePrimarySQL:$dcsSQL,
    dualPrimary:{writablePrimaries:$writablePrimaries,failClosed:$dualPrimaryFailClosed},
    replication:{asyncModeExercised:($asyncMode=="false"),syncModeRestored:($syncMode=="true"),synchronousStandbyNames:$syncNames},
    recovery:{targetTime:$targetTime,rows:$rows,rebuiltReplicas:$replicas,timeline:$timeline,archive:$archive,
      externalWriteFence:$fence,restorePreflight:{recoverySignalVerified:($restoreSignal=="true"),
      targetActionPromoteVerified:($restoreAction=="true"),targetSelectorVerified:($restoreTarget=="true"),
      standbyResidueAbsent:($standbyResidueAbsent=="true"),targetLSN:$targetLSN,targetWALSegment:$targetWALSegment,
      configuredRestoreCommand:$restoreCommand,archiveGet:{exitCode:$archiveGetRC,bytes:$archiveGetBytes,
      diagnostic:$archiveGetDiagnostic},patroniRestartHTTP:$restartHTTP,
      promotedDataDirVerified:($promotedDataDir=="true")}},
    leaderAdmission:{originalPresent:($admissionOriginalPresent=="true"),originalValue:$admissionOriginalValue,
      overrideValue:$admissionOverrideValue,overrideStillApplied:($admissionOverrideApplied=="true"),
      restored:($admissionRestored=="true")},
    logs:{isolatedRecovery:$isolatedLog,patroniHandback:$patroniLog},
    dcsReconcile:{leaderBefore:$dcsLeaderBefore,leaderBeforeResponse:$dcsLeaderBeforeResponse,
      historyBefore:$dcsHistoryBefore,historyBeforeResponse:$dcsHistoryBeforeResponse,
      leaderAfter:$dcsLeaderAfter,leaderAfterResponse:$dcsLeaderAfterResponse,
      historyAfter:$dcsHistoryAfter,historyAfterResponse:$dcsHistoryAfterResponse},
    rollback:{automatic:false,point:"all pre-PITR standby PGDATA and the former primary PGDATA are destructively replaced; rollback requires a separate quarantined copy"},cluster:$cluster}' >"$evidence_file"
printf 'evidence=%s\n' "$evidence_file"
printf 'RESULT=PASS\n'
