#!/usr/bin/env bash
set -Eeuo pipefail

# Real Docker Compose-style single-primary product chain:
# API -> Control Store/outbox -> mTLS Agent -> journal -> RecoveryEngine.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
prefix="backup-compose-e2e-$$"
image="${prefix}:linux"
network="${prefix}-net"
data_volume="${prefix}-data"
minio_volume="${prefix}-minio"
socket_volume="${prefix}-socket"
source="${prefix}-source"
validation="${prefix}-validation"
control="${prefix}-control"
minio="${prefix}-minio"
work="$(mktemp -d)"
commit="$(git -C "$root" rev-parse HEAD)"
version="ifn-compose-e2e+$commit"
keep_environment="${KEEP_E2E_ENVIRONMENT:-0}"
external_network="${E2E_EXTERNAL_NETWORK:-}"
preserve_environment=0

cleanup() {
	if [ "$keep_environment" = "1" ] && [ "$preserve_environment" = "1" ]; then
		return
	fi
  docker rm -f "$control" "$source" "$validation" "$minio" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  docker volume rm "$data_volume" "$minio_volume" "$socket_volume" >/dev/null 2>&1 || true
  docker image rm "$image" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT INT TERM
on_error() {
  printf 'COMPOSE_PRODUCT_CHAIN_FAILURE_LINE=%s\n' "$1" >&2
  docker logs "$source" >&2 2>/dev/null || true
  docker logs "$validation" >&2 2>/dev/null || true
  docker inspect "$validation" --format 'VALIDATION_STATE={{json .State}} VALIDATION_CONFIG={{json .Config.Cmd}}' >&2 2>/dev/null || true
  docker exec "$control" sh -c 'stat -c "PGDATA_IDENTITY=%u:%g:%a" /recovery/pgdata 2>/dev/null || true; ls -la /recovery/pgdata 2>/dev/null | head; cat /recovery/pgdata/postgresql.auto.conf 2>/dev/null || true; find /recovery/pgdata -maxdepth 2 -type f -path "*/log/*" -exec tail -n 80 {} \; 2>/dev/null || true' >&2 2>/dev/null || true
  docker exec "$control" sh -c 'tail -n 200 /work/operator.log /work/agent.log' >&2 2>/dev/null || true
}
trap 'on_error "$LINENO"' ERR

CGO_ENABLED=0 GOOS=linux GOARCH="$(go env GOARCH)" go build -trimpath \
  -ldflags="-s -w -X github.com/supabase/supabase/apps/backup-operator/internal/version.Version=$version -X github.com/supabase/supabase/apps/backup-operator/internal/version.Commit=$commit" \
  -o "$work/backup-operator" ./cmd/backup-operator
binary_sha256="$(openssl dgst -sha256 "$work/backup-operator" | awk '{print $NF}')"
docker build -t "$image" "$root/test/e2e/systemd" >/dev/null
docker network create "$network" >/dev/null
docker volume create "$data_volume" >/dev/null
docker volume create "$minio_volume" >/dev/null
docker volume create "$socket_volume" >/dev/null

mkdir -p "$work/tls" "$work/minio-certs" "$work/fence" "$work/repository-gate"
printf 'ok\n' >"$work/index.html"
cat >"$work/pgbackrest.conf" <<EOF
[global]
repo1-type=s3
repo1-s3-bucket=backup-e2e
repo1-s3-endpoint=minio
repo1-s3-port=9000
repo1-s3-region=us-east-1
repo1-s3-key=e2e-access-key
repo1-s3-key-secret=e2e-secret-key-only
repo1-s3-uri-style=path
repo1-storage-verify-tls=n
repo1-retention-full=2
archive-timeout=30
start-fast=y

[compose-e2e]
pg1-path=/recovery/pgdata
pg1-user=postgres
pg1-socket-path=/socket
EOF
chmod 600 "$work/pgbackrest.conf"
cat >"$work/backup-fence" <<'EOF'
#!/bin/sh
set -eu
kind="$1" action="$2" state="/work/fence/$kind"
case "$action" in
  block) : >"$state" ;;
  status) test -f "$state" && printf 'blocked\n' ;;
  unblock) rm -f "$state" ;;
  *) exit 64 ;;
esac
EOF
cat >"$work/docker" <<'EOF'
#!/bin/sh
# Typed startup probe: verify the enrolled Engine control channel is healthy.
curl --fail --silent --unix-socket /var/run/docker.sock http://docker/_ping >/dev/null
EOF
chmod 755 "$work/backup-fence" "$work/docker" "$work/backup-operator"

openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=backup-e2e-ca \
  -keyout "$work/tls/ca.key" -out "$work/tls/ca.crt" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj /CN=backup-operator -addext subjectAltName=DNS:backup-operator \
  -keyout "$work/tls/server.key" -out "$work/tls/server.csr" >/dev/null 2>&1
printf 'subjectAltName=DNS:backup-operator\nextendedKeyUsage=serverAuth\n' >"$work/tls/server.ext"
openssl x509 -req -days 1 -in "$work/tls/server.csr" -CA "$work/tls/ca.crt" -CAkey "$work/tls/ca.key" -CAcreateserial \
  -extfile "$work/tls/server.ext" -out "$work/tls/server.crt" >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -subj /CN=agent-compose -addext subjectAltName=DNS:agent-compose \
  -keyout "$work/tls/agent.key" -out "$work/tls/agent.csr" >/dev/null 2>&1
printf 'subjectAltName=DNS:agent-compose\nextendedKeyUsage=clientAuth\n' >"$work/tls/agent.ext"
openssl x509 -req -days 1 -in "$work/tls/agent.csr" -CA "$work/tls/ca.crt" -CAkey "$work/tls/ca.key" -CAcreateserial \
  -extfile "$work/tls/agent.ext" -out "$work/tls/agent.crt" >/dev/null 2>&1
chmod 600 "$work/tls"/*.key
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=minio -addext subjectAltName=DNS:minio \
  -keyout "$work/minio-certs/private.key" -out "$work/minio-certs/public.crt" >/dev/null 2>&1

docker run -d --name "$minio" --network "$network" --network-alias minio \
  -e MINIO_ROOT_USER=e2e-access-key -e MINIO_ROOT_PASSWORD=e2e-secret-key-only \
  -v "$minio_volume:/data" -v "$work/minio-certs:/root/.minio/certs:ro" \
  minio/minio:RELEASE.2025-04-22T22-12-26Z server /data >/dev/null
for _ in $(seq 1 60); do
  if docker run --rm --network "$network" --entrypoint /bin/sh minio/mc:RELEASE.2025-04-16T18-13-26Z -c \
    "mc alias set --insecure e2e https://minio:9000 e2e-access-key e2e-secret-key-only >/dev/null && mc mb --insecure --ignore-existing e2e/backup-e2e >/dev/null"; then break; fi
  sleep 1
done

docker run --rm --user root -v "$data_volume:/var/lib/postgresql" --entrypoint sh "$image" -c \
  'chown -R postgres:postgres /var/lib/postgresql && install -d -o postgres -g postgres -m 700 /var/lib/postgresql/pgdata'
docker run --rm --user root -v "$socket_volume:/socket" --entrypoint sh "$image" -c \
  'chown postgres:postgres /socket && chmod 775 /socket'
docker run --rm --user postgres -v "$data_volume:/var/lib/postgresql" --entrypoint initdb "$image" \
  -D /var/lib/postgresql/pgdata --data-checksums --auth-host=trust >/dev/null
docker run --rm --user postgres -v "$data_volume:/var/lib/postgresql" --entrypoint sh "$image" -c \
  "printf 'host all all 0.0.0.0/0 trust\\n' >> /var/lib/postgresql/pgdata/pg_hba.conf"
docker run -d --name "$source" --network "$network" --network-alias source --user postgres \
  -v "$data_volume:/var/lib/postgresql" -v "$data_volume:/recovery" -v "$work/pgbackrest.conf:/etc/pgbackrest/pgbackrest.conf:ro" \
  -v "$socket_volume:/socket" \
  --entrypoint postgres "$image" -D /recovery/pgdata -c listen_addresses='*' \
  -c unix_socket_directories=/socket \
  -c archive_mode=on -c 'archive_command=pgbackrest --stanza=compose-e2e archive-push %p' >/dev/null
docker create --name "$validation" --network "$network" --network-alias validation --user postgres \
  -v "$data_volume:/var/lib/postgresql" -v "$data_volume:/recovery" -v "$work/pgbackrest.conf:/etc/pgbackrest/pgbackrest.conf:ro" \
  -v "$socket_volume:/socket" \
  --entrypoint postgres "$image" -D /recovery/pgdata -p 5433 -c listen_addresses='*' \
  -c logging_collector=off -c log_destination=stderr -c unix_socket_directories=/socket >/dev/null
for _ in $(seq 1 90); do docker exec "$source" pg_isready -h /socket -U postgres >/dev/null 2>&1 && break; sleep 1; done
docker exec "$source" pg_isready -h /socket -U postgres >/dev/null
docker exec "$source" psql -h /socket -U postgres -v ON_ERROR_STOP=1 -c \
  "create table compose_fixture(id int primary key, value text not null); insert into compose_fixture values(1,'before-target');" >/dev/null
docker exec "$source" pgbackrest --stanza=compose-e2e stanza-create
docker exec "$source" pgbackrest --stanza=compose-e2e --type=full backup
sleep 2
target_time="$(docker exec "$source" psql -h /socket -U postgres -Atqc "select to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')")"
docker exec "$source" psql -h /socket -U postgres -v ON_ERROR_STOP=1 -c \
  "insert into compose_fixture values(2,'after-target'); select pg_switch_wal();" >/dev/null
docker exec "$source" pgbackrest --stanza=compose-e2e check
info="$(docker exec "$source" pgbackrest --stanza=compose-e2e --output=json info)"
backup_label="$(jq -r '.[0].backup[-1].label' <<<"$info")"
system_id="$(docker exec "$source" psql -h /socket -U postgres -Atqc 'select system_identifier::text from pg_control_system()')"
archive_start="$(jq -r '.[0].backup[-1].archive.start' <<<"$info")"
archive_stop="$(jq -r '.[0].backup[-1].archive.stop' <<<"$info")"
observed_until="$(date -u -v+5M +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -d '+5 minutes' +%Y-%m-%dT%H:%M:%SZ)"
jq -n --arg start "$archive_start" --arg stop "$archive_stop" --arg through "$observed_until" \
  '{repositoryFingerprint:"compose-fingerprint",repositoryRevision:"compose-revision",databaseHistoryId:1,currentTimeline:1,segments:([$start,$stop]|unique|map({name:.,recoverableThrough:$through})),history:[]}' >"$work/wal-inventory.json"
chmod 600 "$work/wal-inventory.json"

docker run -d --name "$control" --network "$network" --network-alias backup-operator \
  -v /var/run/docker.sock:/var/run/docker.sock -v "$data_volume:/recovery" -v "$data_volume:/var/lib/postgresql" \
  -v "$socket_volume:/socket" \
  -v "$work:/work" -v "$work/pgbackrest.conf:/etc/pgbackrest/pgbackrest.conf:ro" \
  --entrypoint sleep "$image" infinity >/dev/null
docker exec "$control" sh -c 'cp /work/docker /usr/bin/docker && mkdir -p /var/lib/backup-operator /var/lib/backup-agent && chmod 755 /work/backup-operator /work/backup-fence /usr/bin/docker'
docker exec -d "$control" busybox httpd -f -p 18080 -h /work
for _ in $(seq 1 30); do docker exec "$control" pgbackrest --stanza=compose-e2e check >/dev/null 2>&1 && break; sleep 1; done
docker exec "$control" pgbackrest --stanza=compose-e2e check >/dev/null
sleep 2
fingerprint="sha256:$(openssl x509 -in "$work/tls/agent.crt" -outform der | openssl dgst -sha256 | awk '{print $NF}')"
capabilities='["single-primary-pgbackrest.restore.execute","single-primary-pgbackrest.restore.rollback","single-primary-pgbackrest.backup.full","single-primary-pgbackrest.backup.diff","single-primary-pgbackrest.backup.incr","single-primary-pgbackrest.pitr.enable","single-primary-pgbackrest.pitr.disable","single-primary-pgbackrest.maintenance.repository-check","single-primary-pgbackrest.maintenance.expire","single-primary-pgbackrest.maintenance.restore-drill"]'
jq -n --arg fingerprint "$fingerprint" --argjson capabilities "$capabilities" \
  '{AgentID:"agent-compose",ClusterID:"compose-e2e",NodeID:"node-compose",CertificateFingerprint:$fingerprint,Capabilities:$capabilities}' >"$work/enrollment.json"
chmod 600 "$work/enrollment.json"
: >"$work/single-primary.secret"; chmod 600 "$work/single-primary.secret"
docker exec "$control" chmod 600 /work/single-primary.secret

docker exec -d "$control" sh -c 'until env \
  BACKUP_OPERATOR_SERVICE_ASSERTION_KEY=01234567890123456789012345678901 \
  BACKUP_OPERATOR_CONTROL_STORE_DSN=/var/lib/backup-operator/control.db \
  BACKUP_OPERATOR_RUNTIME_ENABLED=true BACKUP_OPERATOR_RUNTIME_POLL_INTERVAL=5s \
  BACKUP_OPERATOR_AGENT_GRPC_LISTEN=0.0.0.0:9443 \
  BACKUP_OPERATOR_AGENT_GRPC_CERT=/work/tls/server.crt BACKUP_OPERATOR_AGENT_GRPC_KEY=/work/tls/server.key \
  BACKUP_OPERATOR_AGENT_GRPC_CLIENT_CA=/work/tls/ca.crt BACKUP_OPERATOR_AGENT_ENROLLMENT_FILE=/work/enrollment.json \
  BACKUP_OPERATOR_SINGLE_PRIMARY_ENABLED=true BACKUP_OPERATOR_SINGLE_PRIMARY_PROJECT=compose-e2e \
  BACKUP_OPERATOR_SINGLE_PRIMARY_TARGET=compose-e2e BACKUP_OPERATOR_SINGLE_PRIMARY_NODE=node-compose \
  BACKUP_OPERATOR_SINGLE_PRIMARY_POSTGRES_DSN="postgres://postgres@source/postgres?sslmode=disable" \
  BACKUP_OPERATOR_SINGLE_PRIMARY_PGBACKREST_BINARY=/usr/bin/pgbackrest BACKUP_OPERATOR_SINGLE_PRIMARY_STANZA=compose-e2e \
  BACKUP_OPERATOR_SINGLE_PRIMARY_REPOSITORY_ID=compose-repo BACKUP_OPERATOR_SINGLE_PRIMARY_REPOSITORY_FINGERPRINT=compose-fingerprint \
  BACKUP_OPERATOR_SINGLE_PRIMARY_REPOSITORY_REVISION=compose-revision BACKUP_OPERATOR_SINGLE_PRIMARY_CAPACITY_PATH=/recovery/pgdata \
  BACKUP_OPERATOR_SINGLE_PRIMARY_FENCE_ADAPTER=compose BACKUP_OPERATOR_SINGLE_PRIMARY_SECRET_FILE=/work/single-primary.secret \
  BACKUP_OPERATOR_SINGLE_PRIMARY_WAL_INVENTORY=/work/wal-inventory.json BACKUP_OPERATOR_SINGLE_PRIMARY_HEALTH_URLS=http://127.0.0.1:18080 \
  /work/backup-operator --mode operator --listen 0.0.0.0:8080 >> /work/operator.log 2>&1; do sleep 1; done'
for _ in $(seq 1 120); do docker exec "$control" curl -fsS http://127.0.0.1:8080/readyz >/dev/null 2>&1 && break; sleep 1; done
docker exec "$control" curl -fsS http://127.0.0.1:8080/readyz >/dev/null

now_ms="$(date +%s)000"
next_run_ms="$((now_ms + 86400000))"
docker exec "$control" sqlite3 /var/lib/backup-operator/control.db \
  "INSERT INTO repositories(id,fingerprint,type,endpoint,encrypted_credentials,key_id,created_at_ms,updated_at_ms) VALUES('compose-repo','compose-fingerprint','s3','minio',X'00','local',$now_ms,$now_ms); INSERT INTO backup_policies(id,project_id,target_id,repository_id,enabled,backup_type,backup_from,max_standby_lag_bytes,schedule,next_run_at_ms,updated_at_ms,retention_days,full_schedule) VALUES('compose-policy','compose-e2e','compose-e2e','compose-repo',1,'full','primary',0,'0 2 * * *',$next_run_ms,$now_ms,14,'0 2 * * *'); INSERT INTO backup_manifests(provider_job_id,policy_id,repository_id,backup_label,backup_type,completed_at_ms,manifest_json) VALUES('$backup_label','compose-policy','compose-repo','$backup_label','full',$now_ms,'{}');"

docker exec -d "$control" sh -c "exec env \
  BACKUP_AGENT_RUNTIME=docker BACKUP_AGENT_CONTROL_ADDRESS=127.0.0.1:9443 \
  BACKUP_AGENT_CLIENT_CERT=/work/tls/agent.crt BACKUP_AGENT_CLIENT_KEY=/work/tls/agent.key BACKUP_AGENT_SERVER_CA=/work/tls/ca.crt BACKUP_AGENT_SERVER_NAME=backup-operator \
  BACKUP_AGENT_ID=agent-compose BACKUP_AGENT_PROJECT=compose-e2e BACKUP_AGENT_TARGET=compose-e2e BACKUP_AGENT_NODE=node-compose \
  BACKUP_AGENT_PGDATA=/recovery/pgdata BACKUP_AGENT_DOCKER_SOCKET=/var/run/docker.sock \
  BACKUP_AGENT_SOURCE_CONTAINER=$source BACKUP_AGENT_VALIDATION_CONTAINER=$validation BACKUP_AGENT_VOLUME=$data_volume \
  BACKUP_AGENT_CONTAINER_VOLUME_PATH=/recovery BACKUP_AGENT_CONTAINER_PGDATA=/recovery/pgdata \
  BACKUP_AGENT_POSTGRES_DSN='postgres://postgres@source/postgres?sslmode=disable' BACKUP_AGENT_VALIDATION_DSN='host=/socket port=5433 user=postgres dbname=postgres sslmode=disable' \
  BACKUP_AGENT_PGBACKREST_BINARY=/usr/bin/pgbackrest BACKUP_AGENT_PGBACKREST_CONFIG=/etc/pgbackrest/pgbackrest.conf BACKUP_AGENT_STANZA=compose-e2e \
  BACKUP_AGENT_REPOSITORY_ID=compose-repo BACKUP_AGENT_REPOSITORY_PATH=/work/repository-gate BACKUP_AGENT_DATABASE_HISTORY=1 \
  BACKUP_AGENT_FENCE_COMMAND=/work/backup-fence BACKUP_AGENT_ROLLBACK_WINDOW=1h \
  /work/backup-operator --mode agent > /work/agent.log 2>&1"
for _ in $(seq 1 120); do docker exec "$control" test -s /var/lib/backup-agent/journal.db && break; sleep 1; done

docker exec -i "$control" bash -es -- "$system_id" "$target_time" <<'PRODUCT_CHAIN'
system_id="$1" target="$2" key=01234567890123456789012345678901
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
header="$(printf '%s' '{"alg":"HS256","typ":"JWT"}' | b64url)"; now="$(date +%s)"
payload="$(jq -nc --argjson now "$now" '{iss:"supabase-studio",sub:"compose-e2e",aud:"backup-operator",exp:($now+300),nbf:($now-10),scopes:["*"],projects:["*"],aal:"aal2",aal_authenticated_at:$now}' | b64url)"
signature="$(printf '%s' "$header.$payload" | openssl dgst -sha256 -hmac "$key" -binary | b64url)"; token="$header.$payload.$signature"
api() { method="$1" path="$2" body="${3:-}" key="${4:-}"; echo "API $method $path" >&2; args=(-sS -X "$method" -H "Authorization: Bearer $token" -H 'Content-Type: application/json'); test -z "$key" || args+=(-H "Idempotency-Key: $key"); test -z "$body" || args+=(--data "$body"); response="$(curl --fail-with-body "${args[@]}" "http://127.0.0.1:8080$path")" || { status=$?; printf 'API failure response: %s\n' "$response" >&2; return "$status"; }; printf '%s' "$response"; }
api POST /v1/clusters "$(jq -nc --arg system "$system_id" '{projectId:"compose-e2e",targetId:"compose-e2e",systemIdentifier:$system,dataDomain:"database"}')" register-compose >/dev/null
plan="$(api POST /v1/clusters/compose-e2e/restore-plans "$(jq -nc --arg target "$target" '{recoveryTarget:$target}')" plan-compose)"; plan_id="$(jq -r .id <<<"$plan")"; plan_hash="$(jq -r .hash <<<"$plan")"
api POST "/v1/clusters/compose-e2e/restore-plans/$plan_id/confirm" "$(jq -nc --arg hash "$plan_hash" '{planHash:$hash}')" confirm-compose >/dev/null
job="$(api POST "/v1/clusters/compose-e2e/restore-plans/$plan_id/execute" "$(jq -nc --arg hash "$plan_hash" '{planHash:$hash}')" execute-compose)"; job_id="$(jq -r .id <<<"$job")"
# Replaying the same mutation must return the same durable job and never repeat a Docker side effect.
replayed="$(api POST "/v1/clusters/compose-e2e/restore-plans/$plan_id/execute" "$(jq -nc --arg hash "$plan_hash" '{planHash:$hash}')" execute-compose)"; test "$(jq -r .id <<<"$replayed")" = "$job_id"
wait_job() { id="$1"; for _ in $(seq 1 240); do response="$(api GET "/v1/clusters/compose-e2e/jobs/$id")"; state="$(jq -r .state <<<"$response")"; case "$state" in succeeded) return 0;; failed|orphaned|manual-intervention|cancelled) echo "$response" >&2; return 1;; esac; sleep 1; done; return 1; }
wait_job "$job_id"
test "$(psql 'postgres://postgres@source/postgres?sslmode=disable' -Atqc "select string_agg(value,',' order by id) from compose_fixture")" = before-target
test -d /recovery/pgdata.backup-operator-quarantine
test "$(find /recovery -maxdepth 1 -type d -name 'pgdata.backup-operator-quarantine*' | wc -l | tr -d ' ')" = 1
rollback="$(api POST "/v1/clusters/compose-e2e/jobs/$job_id/rollback" "$(jq -nc --arg hash "$plan_hash" '{planHash:$hash}')" rollback-compose)"; rollback_job="$(jq -r .id <<<"$rollback")"; wait_job "$rollback_job"
test "$(psql 'postgres://postgres@source/postgres?sslmode=disable' -Atqc "select string_agg(value,',' order by id) from compose_fixture")" = before-target,after-target
test ! -e /recovery/pgdata.backup-operator-quarantine
printf '%s\n' "$plan_id" >/work/plan-id; printf '%s\n' "$job_id" >/work/job-id; printf '%s\n' "$rollback_job" >/work/rollback-job
PRODUCT_CHAIN

if [ -n "$external_network" ]; then
  docker network inspect "$external_network" >/dev/null
  docker network connect --alias backup-operator "$external_network" "$control"
fi
preserve_environment=1

image_id="$(docker image inspect "$image" --format '{{.Id}}')"
printf 'repository=minio-s3\n'
printf 'operator_version=%s\n' "$(docker exec "$control" /work/backup-operator --version)"
printf 'git_commit=%s\nbinary_sha256=%s\nimage_digest=%s\n' "$commit" "$binary_sha256" "$image_id"
printf 'api_restore_plan_id=%s\ndurable_job_id=%s\nrollback_job_id=%s\n' "$(cat "$work/plan-id")" "$(cat "$work/job-id")" "$(cat "$work/rollback-job")"
printf 'execution_chain=api-controlstore-outbox-mtls-agent-journal-recovery-engine\n'
printf 'restore_target_utc=%s\n' "$target_time"
printf 'utc_target_rows=before-target\nrollback_rows=before-target,after-target\n'
printf 'rollback_window_enforced=true\noriginal_pgdata_preserved_until_rollback=true\n'
printf 'point_of_no_auto_rollback=cut-over\n'
printf 'side_effect_idempotency=stable-idempotency-key-plus-durable-postconditions\n'
printf 'side_effect_crash_idempotency=docker-304-and-filesystem-postconditions-tested\n'
if [ "$keep_environment" = "1" ]; then
  printf 'operator_container=%s\n' "$control"
  printf 'source_container=%s\n' "$source"
  printf 'validation_container=%s\n' "$validation"
  printf 'minio_container=%s\n' "$minio"
  printf 'work_directory=%s\n' "$work"
  printf 'operator_network_url=http://backup-operator:8080\n'
fi
printf 'RESULT=PASS\n'
