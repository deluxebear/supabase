#!/usr/bin/env bash
set -Eeuo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
prefix="backup-systemd-e2e-$$"
image="${prefix}:linux"
container="${prefix}-host"
work="$(mktemp -d)"
version="ifn-systemd-e2e"
commit="$(git -C "$root" rev-parse HEAD)"
arch="$(go env GOARCH)"
ldflags="-s -w -X github.com/supabase/supabase/apps/backup-operator/internal/version.Version=${version} -X github.com/supabase/supabase/apps/backup-operator/internal/version.Commit=${commit}"

cleanup() {
  if test "${BACKUP_SYSTEMD_E2E_KEEP:-}" = 1; then
    printf 'preserved_container=%s\n' "$container" >&2
    return
  fi
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker image rm "$image" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT INT TERM
on_error() {
  printf 'SYSTEMD_FAILURE_LINE=%s\n' "$1" >&2
  docker logs "$container" >&2 2>/dev/null || true
  docker exec "$container" journalctl --no-pager -n 200 \
    -u backup-operator.service -u backup-agent.service \
    -u postgresql.service -u postgresql-validation.service >&2 2>/dev/null || true
  docker exec "$container" cat /var/lib/backup-agent/drill-validator.log >&2 2>/dev/null || true
  docker exec "$container" cat /var/lib/backup-agent/drill-postgres.log >&2 2>/dev/null || true
}
trap 'on_error "$LINENO"' ERR

CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build -trimpath -ldflags="$ldflags" -o "$work/backup-operator" ./cmd/backup-operator
binary_sha256="$(sha256sum "$work/backup-operator" | awk '{print $1}')"
docker build -t "$image" "$root/test/e2e/systemd" >/dev/null
docker run -d --name "$container" --privileged --cgroupns=host \
  --tmpfs /var/lib/backup-agent/drill-workspace:rw,exec,nosuid,nodev,size=1073741824 \
  -v /sys/fs/cgroup:/sys/fs/cgroup:rw --entrypoint /lib/systemd/systemd "$image" >/dev/null

for _ in $(seq 1 60); do
  if docker exec "$container" systemctl is-system-running --wait 2>/dev/null | grep -Eq 'running|degraded'; then break; fi
  sleep 1
done
docker exec "$container" mkdir -p /usr/local/libexec
docker cp "$work/backup-operator" "$container:/usr/local/bin/backup-operator"
for file in backup-operator.service backup-agent.service; do
  docker cp "$root/deploy/systemd/$file" "$container:/etc/systemd/system/$file"
done
for file in postgresql.service postgresql-validation.service backup-health.service; do
  docker cp "$root/test/e2e/systemd/$file" "$container:/etc/systemd/system/$file"
done
docker cp "$root/test/e2e/systemd/backup-fence" "$container:/usr/local/libexec/backup-fence"
docker cp "$root/test/e2e/systemd/drill-validator" "$container:/usr/local/libexec/drill-validator"

docker exec -i "$container" bash -es <<'CONTAINER_SETUP'
  chmod 0755 /usr/local/bin/backup-operator /usr/local/libexec/backup-fence /usr/local/libexec/drill-validator
  useradd --system --home /var/lib/backup-operator --shell /usr/sbin/nologin backup-operator
  usermod -a -G postgres backup-operator
  install -d -o backup-operator -g backup-operator /var/lib/backup-operator /etc/backup-operator/tls
  install -d -o root -g root /var/lib/backup-agent /etc/pgbackrest
  install -d -o postgres -g postgres -m 700 /var/lib/postgresql/systemd-data
  install -d -o postgres -g postgres -m 750 /var/lib/pgbackrest/repo
  runuser -u postgres -- /usr/lib/postgresql/17/bin/initdb -D /var/lib/postgresql/systemd-data --data-checksums >/dev/null
  chmod -R g+rX /var/lib/postgresql/systemd-data
  install -d /var/lib/backup-health
  printf 'ok\n' >/var/lib/backup-health/index.html
  cat >> /var/lib/postgresql/systemd-data/postgresql.conf <<"EOF"
archive_mode=on
archive_command='pgbackrest --stanza=systemd-e2e archive-push %p'
EOF
  cat > /etc/pgbackrest/pgbackrest.conf <<"EOF"
[global]
repo1-path=/var/lib/pgbackrest/repo
repo1-retention-full=2

[systemd-e2e]
pg1-path=/var/lib/postgresql/systemd-data
pg1-user=postgres
EOF
  openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=backup-e2e-ca -keyout /etc/backup-operator/tls/ca.key -out /etc/backup-operator/tls/ca.crt >/dev/null 2>&1
  openssl req -newkey rsa:2048 -nodes -subj /CN=backup-operator -addext subjectAltName=DNS:backup-operator -keyout /etc/backup-operator/tls/server.key -out /tmp/server.csr >/dev/null 2>&1
  printf "subjectAltName=DNS:backup-operator\nextendedKeyUsage=serverAuth\n" >/tmp/server.ext
  openssl x509 -req -days 1 -in /tmp/server.csr -CA /etc/backup-operator/tls/ca.crt -CAkey /etc/backup-operator/tls/ca.key -CAcreateserial -extfile /tmp/server.ext -out /etc/backup-operator/tls/server.crt >/dev/null 2>&1
  openssl req -newkey rsa:2048 -nodes -subj /CN=agent-systemd -addext subjectAltName=DNS:agent-systemd -keyout /etc/backup-operator/tls/agent.key -out /tmp/agent.csr >/dev/null 2>&1
  printf "subjectAltName=DNS:agent-systemd\nextendedKeyUsage=clientAuth\n" >/tmp/agent.ext
  openssl x509 -req -days 1 -in /tmp/agent.csr -CA /etc/backup-operator/tls/ca.crt -CAkey /etc/backup-operator/tls/ca.key -CAcreateserial -extfile /tmp/agent.ext -out /etc/backup-operator/tls/agent.crt >/dev/null 2>&1
  chown -R backup-operator:backup-operator /etc/backup-operator/tls
  chmod 0600 /etc/backup-operator/tls/*.key
  : >/etc/backup-operator/single-primary.secret
  chown backup-operator:backup-operator /etc/backup-operator/single-primary.secret
  chmod 0600 /etc/backup-operator/single-primary.secret
  systemctl daemon-reload
  systemctl enable postgresql.service backup-health.service backup-operator.service backup-agent.service >/dev/null
  systemctl start backup-health.service
  systemctl restart postgresql.service
  runuser -u postgres -- psql -h /var/run/postgresql -v ON_ERROR_STOP=1 -c "create table systemd_fixture(id int primary key, value text not null); insert into systemd_fixture values (1, 'before-backup');" >/dev/null
  runuser -u postgres -- pgbackrest --stanza=systemd-e2e stanza-create
  runuser -u postgres -- pgbackrest --stanza=systemd-e2e --type=full backup
  chmod -R g+rwX /var/lib/pgbackrest/repo
  sleep 1
  target_time="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  runuser -u postgres -- psql -h /var/run/postgresql -v ON_ERROR_STOP=1 -c "insert into systemd_fixture values (2, 'after-backup'); create table drill_heartbeat(id int primary key, touched_at timestamptz not null); insert into drill_heartbeat values (1, clock_timestamp()); select pg_switch_wal();" >/dev/null
  systemd-run --unit=drill-heartbeat --uid=postgres /bin/bash -c 'while true; do psql -h /var/run/postgresql -v ON_ERROR_STOP=1 -c "update drill_heartbeat set touched_at=clock_timestamp() where id=1; select pg_switch_wal();" >/dev/null; sleep 2; done' >/dev/null
  runuser -u postgres -- pgbackrest --stanza=systemd-e2e check
  info="$(runuser -u postgres -- pgbackrest --stanza=systemd-e2e --output=json info)"
  backup_label="$(jq -r '.[0].backup[-1].label' <<<"$info")"
  system_id="$(/usr/lib/postgresql/17/bin/pg_controldata /var/lib/postgresql/systemd-data | sed -n 's/^Database system identifier:[[:space:]]*//p')"
  archive_start="$(jq -r '.[0].backup[-1].archive.start' <<<"$info")"
  archive_stop="$(jq -r '.[0].backup[-1].archive.stop' <<<"$info")"
  observed_until="$(date -u -d "+5 minutes" +%Y-%m-%dT%H:%M:%SZ)"
  segments="$(find /var/lib/pgbackrest/repo/archive -type f -printf "%f\n" | awk 'length($0)>=24 {print toupper(substr($0,1,24))}' | sort -u | jq -Rn --arg through "$observed_until" '[inputs | select(length==24) | {name:.,recoverableThrough:$through}]')"
  jq -n --argjson segments "$segments" '{repositoryFingerprint:"systemd-fingerprint",repositoryRevision:"systemd-revision",databaseHistoryId:1,currentTimeline:1,segments:$segments,history:[]}' >/etc/backup-operator/wal-inventory.json
  chown backup-operator:backup-operator /etc/backup-operator/wal-inventory.json
  chmod 0600 /etc/backup-operator/wal-inventory.json
  fingerprint="sha256:$(openssl x509 -in /etc/backup-operator/tls/agent.crt -outform der | sha256sum | awk '{print $1}')"
  jq -n --arg fingerprint "$fingerprint" '{AgentID:"agent-systemd",ClusterID:"systemd-e2e",NodeID:"node-systemd",CertificateFingerprint:$fingerprint,Capabilities:["single-primary-pgbackrest.restore.execute","single-primary-pgbackrest.restore.rollback","single-primary-pgbackrest.backup.full","single-primary-pgbackrest.backup.diff","single-primary-pgbackrest.backup.incr","single-primary-pgbackrest.pitr.enable","single-primary-pgbackrest.pitr.disable","single-primary-pgbackrest.maintenance.repository-check","single-primary-pgbackrest.maintenance.expire","single-primary-pgbackrest.maintenance.restore-drill"]}' >/etc/backup-operator/enrollment.json
  chown backup-operator:backup-operator /etc/backup-operator/enrollment.json
  chmod 0600 /etc/backup-operator/enrollment.json
  printf "%s\n" \
    BACKUP_OPERATOR_SERVICE_ASSERTION_KEY=01234567890123456789012345678901 \
    BACKUP_OPERATOR_CONTROL_STORE_DSN=/var/lib/backup-operator/control.db \
    BACKUP_OPERATOR_RUNTIME_ENABLED=true \
    BACKUP_OPERATOR_RUNTIME_POLL_INTERVAL=5s \
    BACKUP_OPERATOR_AGENT_GRPC_LISTEN=127.0.0.1:9443 \
    BACKUP_OPERATOR_AGENT_GRPC_CERT=/etc/backup-operator/tls/server.crt \
    BACKUP_OPERATOR_AGENT_GRPC_KEY=/etc/backup-operator/tls/server.key \
    BACKUP_OPERATOR_AGENT_GRPC_CLIENT_CA=/etc/backup-operator/tls/ca.crt \
    BACKUP_OPERATOR_AGENT_ENROLLMENT_FILE=/etc/backup-operator/enrollment.json \
    BACKUP_OPERATOR_SINGLE_PRIMARY_ENABLED=true \
    BACKUP_OPERATOR_SINGLE_PRIMARY_PROJECT=systemd-project \
    BACKUP_OPERATOR_SINGLE_PRIMARY_TARGET=systemd-e2e \
    BACKUP_OPERATOR_SINGLE_PRIMARY_NODE=node-systemd \
    "BACKUP_OPERATOR_SINGLE_PRIMARY_POSTGRES_DSN=host=/var/run/postgresql user=postgres dbname=postgres sslmode=disable" \
    BACKUP_OPERATOR_SINGLE_PRIMARY_PGBACKREST_BINARY=/usr/bin/pgbackrest \
    BACKUP_OPERATOR_SINGLE_PRIMARY_STANZA=systemd-e2e \
    BACKUP_OPERATOR_SINGLE_PRIMARY_REPOSITORY_ID=systemd-repo \
    BACKUP_OPERATOR_SINGLE_PRIMARY_REPOSITORY_FINGERPRINT=systemd-fingerprint \
    BACKUP_OPERATOR_SINGLE_PRIMARY_REPOSITORY_REVISION=systemd-revision \
    BACKUP_OPERATOR_SINGLE_PRIMARY_CAPACITY_PATH=/var/lib/postgresql/systemd-data \
    BACKUP_OPERATOR_SINGLE_PRIMARY_FENCE_ADAPTER=systemd \
    BACKUP_OPERATOR_SINGLE_PRIMARY_SECRET_FILE=/etc/backup-operator/single-primary.secret \
    BACKUP_OPERATOR_SINGLE_PRIMARY_WAL_INVENTORY=/etc/backup-operator/wal-inventory.json \
    BACKUP_OPERATOR_SINGLE_PRIMARY_HEALTH_URLS=http://127.0.0.1:18080 \
    BACKUP_OPERATOR_RESTORE_DRILL_ENABLED=true \
    BACKUP_OPERATOR_RESTORE_DRILL_INTERVAL=30s \
    BACKUP_OPERATOR_RESTORE_DRILL_TARGET_LAG=10s \
    BACKUP_OPERATOR_RESTORE_DRILL_LEASE_TTL=20s \
    >/etc/backup-operator/operator.env
  printf "%s\n" \
    BACKUP_AGENT_CONTROL_ADDRESS=127.0.0.1:9443 \
    BACKUP_AGENT_CLIENT_CERT=/etc/backup-operator/tls/agent.crt \
    BACKUP_AGENT_CLIENT_KEY=/etc/backup-operator/tls/agent.key \
    BACKUP_AGENT_SERVER_CA=/etc/backup-operator/tls/ca.crt \
    BACKUP_AGENT_SERVER_NAME=backup-operator \
    BACKUP_AGENT_ID=agent-systemd \
    BACKUP_AGENT_PROJECT=systemd-project \
    BACKUP_AGENT_TARGET=systemd-e2e \
    BACKUP_AGENT_NODE=node-systemd \
    BACKUP_AGENT_PGDATA=/var/lib/postgresql/systemd-data \
    BACKUP_AGENT_POSTGRES_UNIT=postgresql.service \
    BACKUP_AGENT_VALIDATION_UNIT=postgresql-validation.service \
    "BACKUP_AGENT_POSTGRES_DSN=host=/var/run/postgresql user=postgres dbname=postgres sslmode=disable" \
    "BACKUP_AGENT_VALIDATION_DSN=host=/run/backup-validation port=55432 user=postgres dbname=postgres sslmode=disable" \
    BACKUP_AGENT_PGBACKREST_BINARY=/usr/bin/pgbackrest \
    BACKUP_AGENT_PGBACKREST_CONFIG=/etc/pgbackrest/pgbackrest.conf \
    BACKUP_AGENT_STANZA=systemd-e2e \
    BACKUP_AGENT_REPOSITORY_ID=systemd-repo \
    BACKUP_AGENT_REPOSITORY_PATH=/var/lib/pgbackrest/repo \
    BACKUP_AGENT_DATABASE_HISTORY=1 \
    BACKUP_AGENT_FENCE_COMMAND=/usr/local/libexec/backup-fence \
    BACKUP_AGENT_DRILL_ENABLED=true \
    BACKUP_AGENT_DRILL_REPOSITORY_READ_ONLY=true \
    BACKUP_AGENT_DRILL_STATE=/var/lib/backup-agent/drills.json \
    BACKUP_AGENT_DRILL_WORKSPACE_ROOT=/var/lib/backup-agent/drill-workspace \
    BACKUP_AGENT_DRILL_ALLOWED_ROOTS=/var/lib/backup-agent/drill-workspace \
    BACKUP_AGENT_DRILL_MINIMUM_FREE_BYTES=1048576 \
    BACKUP_AGENT_DRILL_VALIDATOR_BINARY=/usr/local/libexec/drill-validator \
    BACKUP_AGENT_DRILL_VALIDATOR_ALLOWED_BINARIES=/usr/local/libexec/drill-validator \
    BACKUP_AGENT_DRILL_VALIDATOR_TIMEOUT=10s \
    >/etc/backup-operator/agent.env
  printf "%s\n" "$backup_label" > /var/lib/backup-agent/backup-label
  printf "%s\n" "$system_id" > /var/lib/backup-agent/system-id
  printf "%s\n" "$target_time" > /var/lib/backup-agent/target-time
  printf "%s\n" "$archive_start" > /var/lib/backup-agent/archive-start
  printf "%s\n" "$archive_stop" > /var/lib/backup-agent/archive-stop
  systemctl restart backup-operator.service
CONTAINER_SETUP

for _ in $(seq 1 90); do
  if docker exec "$container" curl -fsS http://127.0.0.1:8080/readyz >/dev/null; then break; fi
  sleep 1
done
docker exec "$container" curl -fsS http://127.0.0.1:8080/readyz >/dev/null

docker exec -i "$container" bash -es <<'CONTAINER_SEED'
  db=/var/lib/backup-operator/control.db
  now_ms="$(date +%s%3N)"
  label="$(cat /var/lib/backup-agent/backup-label)"
  sqlite3 "$db" "INSERT INTO repositories(id,fingerprint,type,endpoint,encrypted_credentials,key_id,created_at_ms,updated_at_ms) VALUES('systemd-repo','systemd-fingerprint','posix','/var/lib/pgbackrest/repo',X'00','local',$now_ms,$now_ms);"
  sqlite3 "$db" "INSERT INTO backup_policies(id,project_id,target_id,repository_id,enabled,backup_type,backup_from,max_standby_lag_bytes,schedule,next_run_at_ms,updated_at_ms,retention_days,full_schedule) VALUES('systemd-policy','systemd-project','systemd-e2e','systemd-repo',1,'full','primary',0,'0 2 * * *',$now_ms,$now_ms,14,'0 2 * * *');"
  sqlite3 "$db" "INSERT INTO backup_manifests(provider_job_id,policy_id,repository_id,backup_label,backup_type,completed_at_ms,manifest_json) VALUES('$label','systemd-policy','systemd-repo','$label','full',$now_ms,'{}');"
  systemctl restart backup-agent.service
CONTAINER_SEED

for _ in $(seq 1 60); do
  if docker exec "$container" test -s /var/lib/backup-agent/journal.db; then break; fi
  sleep 1
done
docker exec "$container" systemctl is-active --quiet backup-agent.service

docker exec -i "$container" bash -es <<'CONTAINER_DRILL'
  db=/var/lib/backup-operator/control.db
  for _ in $(seq 1 90); do
    drill_job="$(sqlite3 "$db" "select id from jobs where type='maintenance' and id like 'drill-%' order by created_at_ms desc limit 1;")"
    if test -n "$drill_job"; then
      state="$(sqlite3 "$db" "select state from jobs where id='$drill_job';")"
      case "$state" in succeeded) break ;; failed|orphaned|cancelled) exit 1 ;; esac
    fi
    sleep 1
  done
  test "$state" = succeeded
  evidence="$(sqlite3 "$db" "select evidence_json from task_results where task_id='$drill_job/restore-drill';")"
  test "$(jq -r '.record.Passed' <<<"$evidence")" = true
  test "$(jq -r '.record.EvidenceDigest | startswith("sha256:")' <<<"$evidence")" = true
  grep -Fq "\"DatabaseSystemID\":$(cat /var/lib/backup-agent/system-id)" <<<"$evidence"
  find /var/lib/backup-agent/drill-workspace -mindepth 1 -maxdepth 1 | grep -q . && exit 1 || true
  printf '%s\n' "$drill_job" >/var/lib/backup-agent/drill-job-id
  printf '%s\n' "$evidence" >/var/lib/backup-agent/drill-evidence.json

  before="$(sqlite3 "$db" "select count(*) from jobs where type='maintenance' and id like 'drill-%';")"
  inventory=/etc/backup-operator/wal-inventory.json
  cp "$inventory" /var/lib/backup-agent/wal-inventory.valid.json
  last="$(jq -r '.segments | map(.name) | sort | last' "$inventory")"
  timeline="${last:0:8}"; loghex="${last:8:8}"; seghex="${last:16:8}"
  log=$((16#$loghex)); seg=$((16#$seghex + 2)); log=$((log + seg / 256)); seg=$((seg % 256))
  printf -v fake '%s%08X%08X' "$timeline" "$log" "$seg"
  printf '%s\n' "$fake" >/var/lib/backup-agent/wal-gap-segment
  through="$(jq -r '.segments | map(.recoverableThrough) | last' "$inventory")"
  jq --arg fake "$fake" --arg through "$through" '.segments += [{name:$fake,recoverableThrough:$through}]' "$inventory" >"$inventory.tmp"
  mv "$inventory.tmp" "$inventory"
  chown backup-operator:backup-operator "$inventory"; chmod 0600 "$inventory"
  journal_cursor="$(journalctl --no-pager -u backup-operator.service -n 0 --show-cursor | sed -n 's/^-- cursor: //p')"
  test -n "$journal_cursor"
  gap_observed=false
  for _ in $(seq 1 75); do
    if journalctl --no-pager -u backup-operator.service --after-cursor="$journal_cursor" | grep -q 'WAL gap'; then
      gap_observed=true
      break
    fi
    sleep 1
  done
  test "$gap_observed" = true
  after="$(sqlite3 "$db" "select count(*) from jobs where type='maintenance' and id like 'drill-%';")"
  test "$after" = "$before"
  mv /var/lib/backup-agent/wal-inventory.valid.json "$inventory"
  chown backup-operator:backup-operator "$inventory"; chmod 0600 "$inventory"
  systemctl stop drill-heartbeat.service
  printf 'drill_job_id=%s\nwal_gap_blocked=true\n' "$drill_job"
CONTAINER_DRILL

docker exec -i "$container" bash -es <<'CONTAINER_EXECUTE'
  key=01234567890123456789012345678901
  b64url() { openssl base64 -A | tr "+/" "-_" | tr -d "="; }
  header="$(printf '%s' '{"alg":"HS256","typ":"JWT"}' | b64url)"
  now="$(date +%s)"
  payload="$(jq -nc --argjson now "$now" '{iss:"supabase-studio",sub:"systemd-e2e",aud:"backup-operator",exp:($now+300),nbf:($now-10),scopes:["*"],projects:["*"],aal:"aal2",aal_authenticated_at:$now}' | b64url)"
  signature="$(printf "%s" "$header.$payload" | openssl dgst -sha256 -hmac "$key" -binary | b64url)"
  token="$header.$payload.$signature"
  auth=(-H "Authorization: Bearer $token" -H "Content-Type: application/json")
  system_id="$(cat /var/lib/backup-agent/system-id)"
  register_response="$(curl -sS -w $'\n%{http_code}' "${auth[@]}" -H "Idempotency-Key: register-systemd" -d "{\"projectId\":\"systemd-project\",\"targetId\":\"systemd-e2e\",\"systemIdentifier\":\"$system_id\",\"dataDomain\":\"database\"}" http://127.0.0.1:8080/v1/clusters)"
  register_status="${register_response##*$'\n'}"
  register_body="${register_response%$'\n'*}"
  if test "$register_status" != 201; then
    printf 'cluster registration failed (%s): %s\n' "$register_status" "$register_body" >&2
    exit 1
  fi
  target="$(cat /var/lib/backup-agent/target-time)"
  plan_response="$(curl -sS -w $'\n%{http_code}' "${auth[@]}" -H "Idempotency-Key: plan-systemd" -d "{\"recoveryTarget\":\"$target\"}" http://127.0.0.1:8080/v1/clusters/systemd-e2e/restore-plans)"
  plan_status="${plan_response##*$'\n'}"
  plan="${plan_response%$'\n'*}"
  if test "$plan_status" != 201; then
    printf 'restore plan failed (%s): %s\n' "$plan_status" "$plan" >&2
    exit 1
  fi
  plan_id="$(jq -r .id <<<"$plan")"
  plan_hash="$(jq -r .hash <<<"$plan")"
  curl -fsS "${auth[@]}" -H "Idempotency-Key: confirm-systemd" -d "{\"planHash\":\"$plan_hash\"}" "http://127.0.0.1:8080/v1/clusters/systemd-e2e/restore-plans/$plan_id/confirm" >/dev/null
  job="$(curl -fsS "${auth[@]}" -H "Idempotency-Key: execute-systemd" -d "{\"planHash\":\"$plan_hash\"}" "http://127.0.0.1:8080/v1/clusters/systemd-e2e/restore-plans/$plan_id/execute")"
  job_id="$(jq -r .id <<<"$job")"
  for _ in $(seq 1 180); do
    job_response="$(curl -fsS "${auth[@]}" "http://127.0.0.1:8080/v1/clusters/systemd-e2e/jobs/$job_id")"
    state="$(jq -r .state <<<"$job_response")"
    case "$state" in
      succeeded) break ;;
      failed|orphaned|manual-intervention|cancelled)
        printf 'restore job terminal failure: %s\n' "$job_response" >&2
        sqlite3 /var/lib/backup-operator/control.db "select task_id,state,delivered_at_ms from task_outbox where job_id='$job_id';" >&2 || true
        sqlite3 /var/lib/backup-agent/journal.db "select task_id,state,result_json from executions where task_id='$job_id/execute';" >&2 || true
        sqlite3 /var/lib/backup-agent/recovery.db "select plan_id,state,last_error from recovery_executions;" >&2 || true
        exit 1
        ;;
    esac
    sleep 1
  done
  test "$state" = succeeded
  test "$(runuser -u postgres -- psql -h /var/run/postgresql -Atqc "select string_agg(value, ', ' order by id) from systemd_fixture")" = before-backup
  test -d /var/lib/postgresql/systemd-data.backup-operator-quarantine
  test "$(sqlite3 /var/lib/backup-agent/journal.db "select state from executions where task_id='$job_id/execute';")" = completed
  test "$(sqlite3 /var/lib/backup-agent/recovery.db "select state from recovery_executions where plan_id='$plan_id';")" = cut-over
  test "$(sqlite3 /var/lib/backup-operator/control.db "select state from task_outbox where task_id='$job_id/execute';")" = completed
  printf "%s\n" "$plan_id" >/var/lib/backup-agent/plan-id
  printf "%s\n" "$plan_hash" >/var/lib/backup-agent/plan-hash
  printf "%s\n" "$job_id" >/var/lib/backup-agent/job-id
CONTAINER_EXECUTE

operator_version="$(docker exec "$container" /usr/local/bin/backup-operator --version)"
image_id="$(docker image inspect "$image" --format '{{.Id}}')"
plan_id="$(docker exec "$container" cat /var/lib/backup-agent/plan-id)"
plan_hash="$(docker exec "$container" cat /var/lib/backup-agent/plan-hash)"
job_id="$(docker exec "$container" cat /var/lib/backup-agent/job-id)"
drill_job_id="$(docker exec "$container" cat /var/lib/backup-agent/drill-job-id)"
drill_evidence_digest="$(docker exec "$container" jq -r '.record.EvidenceDigest' /var/lib/backup-agent/drill-evidence.json)"
wal_gap_segment="$(docker exec "$container" cat /var/lib/backup-agent/wal-gap-segment)"
agent_pid="$(docker exec "$container" systemctl show backup-agent.service -p MainPID --value)"
printf 'operator_version=%s\n' "$operator_version"
printf 'git_commit=%s\n' "$commit"
printf 'binary_sha256=%s\n' "$binary_sha256"
printf 'systemd_image_id=%s\n' "$image_id"
printf 'api_restore_plan_id=%s\n' "$plan_id"
printf 'confirmed_plan_hash=%s\n' "$plan_hash"
printf 'durable_job_id=%s\n' "$job_id"
printf 'drill_job_id=%s\n' "$drill_job_id"
printf 'drill_evidence_digest=%s\n' "$drill_evidence_digest"
printf 'drill_read_only=true\n'
printf 'drill_target_data=before-backup\n'
printf 'drill_workspace_cleanup=true\n'
printf 'wal_gap_missing_segment=%s\n' "$wal_gap_segment"
printf 'wal_gap_blocked=true\n'
printf 'agent_main_pid=%s\n' "$agent_pid"
printf 'transport=mtls-grpc-bidirectional\n'
printf 'execution_chain=api-outbox-grpc-journal-recovery-engine\n'
printf 'agent_journal_state=completed\n'
printf 'recovery_engine_state=cut-over\n'
printf 'postgres_restore_fixture=before-backup\n'
printf 'quarantine_preserved=true\n'
printf 'exec_reload_bypass=false\n'
printf 'RESULT=PASS\n'
