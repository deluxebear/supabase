#!/usr/bin/env bash
set -Eeuo pipefail

prefix="backup-pitr-contract-$$"
image="${prefix}:local"
network="${prefix}-net"
minio="${prefix}-minio"
throttle="${prefix}-throttle"
database="${prefix}-database"
data_volume="${prefix}-data"
minio_volume="${prefix}-minio-data"
config_dir="$(mktemp -d)"
access_key="contract-access-key"
secret_key="contract-secret-key"
readonly_key="contract-readonly-key"
readonly_secret="contract-readonly-secret"

cleanup() {
  docker rm -f "$database" "$throttle" "$minio" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  docker volume rm "$data_volume" "$minio_volume" >/dev/null 2>&1 || true
  docker image rm "$image" >/dev/null 2>&1 || true
  rm -rf "$config_dir"
}
trap cleanup EXIT
trap 'printf "CONTRACT_FAILURE_LINE=%s\n" "$LINENO" >&2' ERR

write_config() {
  local endpoint="$1" key="$2" secret="$3" target="$4"
  printf '%s\n' \
    '[global]' \
    'repo1-type=s3' \
    'repo1-s3-bucket=backup-contract' \
    "repo1-s3-endpoint=${endpoint}" \
    'repo1-s3-port=9000' \
    'repo1-s3-region=us-east-1' \
    "repo1-s3-key=${key}" \
    "repo1-s3-key-secret=${secret}" \
    'repo1-s3-uri-style=path' \
    'repo1-storage-verify-tls=n' \
    'repo1-retention-full=2' \
    'archive-timeout=20' \
    'start-fast=y' \
    '' \
    '[contract]' \
    'pg1-path=/var/lib/postgresql/pgdata' \
    'pg1-user=postgres' >"$target"
  chmod 600 "$target"
}

wait_postgres() {
  for _ in $(seq 1 90); do
    if docker exec "$database" pg_isready -U postgres -d postgres >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  docker logs "$database" >&2
  return 1
}

start_postgres() {
  local archive_mode="$1"
  docker rm -f "$database" >/dev/null 2>&1 || true
  local args=(-D /var/lib/postgresql/pgdata -c listen_addresses='')
  if [ "$archive_mode" = on ]; then
    args+=(-c archive_mode=on -c 'archive_command=pgbackrest --stanza=contract archive-push %p')
  else
    args+=(-c archive_mode=off)
  fi
  docker run -d --name "$database" --network "$network" --user postgres \
    -v "$data_volume:/var/lib/postgresql" \
    -v "$config_dir/pgbackrest.conf:/etc/pgbackrest/pgbackrest.conf:ro" \
    --entrypoint postgres "$image" "${args[@]}" >/dev/null
  wait_postgres
}

mc() {
  docker run --rm --network "$network" -v "$config_dir:/contract" --entrypoint /bin/sh \
    minio/mc:RELEASE.2025-04-16T18-13-26Z -c \
    "mc alias set --insecure contract https://minio:9000 '$access_key' '$secret_key' >/dev/null && mc() { command mc --insecure \"\$@\"; } && $*"
}

object_count() {
  mc "mc find contract/backup-contract | wc -l" | tr -d '[:space:]'
}

write_config minio "$access_key" "$secret_key" "$config_dir/pgbackrest.conf"
mkdir -p "$config_dir/certs"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=minio' \
  -addext 'subjectAltName=DNS:minio,DNS:minio-throttle' \
  -keyout "$config_dir/certs/private.key" -out "$config_dir/certs/public.crt" >/dev/null 2>&1
printf '%s\n' \
  'limit_req_zone $binary_remote_addr zone=s3_contract:10m rate=1r/s;' \
  'server {' \
  '  listen 9000 ssl;' \
  '  ssl_certificate /contract/certs/public.crt;' \
  '  ssl_certificate_key /contract/certs/private.key;' \
  '  location / {' \
  '    limit_req zone=s3_contract burst=1 nodelay;' \
  '    limit_req_status 429;' \
  '    proxy_ssl_verify off;' \
  '    proxy_set_header Host $http_host;' \
  '    proxy_pass https://minio:9000;' \
  '  }' \
  '}' >"$config_dir/nginx.conf"
printf '%s\n' \
  '{"Version":"2012-10-17","Statement":[' \
  '{"Effect":"Allow","Action":["s3:GetBucketLocation","s3:ListBucket"],"Resource":["arn:aws:s3:::backup-contract"]},' \
  '{"Effect":"Allow","Action":["s3:GetObject"],"Resource":["arn:aws:s3:::backup-contract/*"]}' \
  ']}' >"$config_dir/readonly.json"

docker build -t "$image" ./spikes/patroni >/dev/null
docker network create "$network" >/dev/null
docker volume create "$data_volume" >/dev/null
docker volume create "$minio_volume" >/dev/null
docker run -d --name "$minio" --network "$network" --network-alias minio \
  -e MINIO_ROOT_USER="$access_key" -e MINIO_ROOT_PASSWORD="$secret_key" \
  -v "$minio_volume:/data" -v "$config_dir/certs:/root/.minio/certs:ro" \
  minio/minio:RELEASE.2025-04-22T22-12-26Z server /data >/dev/null
for _ in $(seq 1 60); do
  if mc 'mc mb --ignore-existing contract/backup-contract >/dev/null'; then break; fi
  sleep 1
done
mc 'mc stat contract/backup-contract >/dev/null'

docker run --rm --user root -v "$data_volume:/var/lib/postgresql" --entrypoint chown "$image" -R postgres:postgres /var/lib/postgresql >/dev/null
docker run --rm --user postgres -v "$data_volume:/var/lib/postgresql" --entrypoint initdb "$image" -D /var/lib/postgresql/pgdata --data-checksums >/dev/null

# IFN-44: real enable sequence and first full backup.
start_postgres off
test "$(docker exec "$database" psql -U postgres -Atqc 'show archive_mode')" = off
start_postgres on
docker exec --user postgres "$database" pgbackrest --stanza=contract stanza-create >/dev/null
docker exec --user postgres "$database" pgbackrest --stanza=contract check >/dev/null
docker exec "$database" psql -U postgres -v ON_ERROR_STOP=1 -c "create table drill_marker(id int primary key, value text); insert into drill_marker values (1, 'enable-contract'); select pg_switch_wal();" >/dev/null
docker exec --user postgres "$database" pgbackrest --stanza=contract --type=full backup >/dev/null
first_backup_count="$(docker exec --user postgres "$database" pgbackrest --stanza=contract --output=json info | jq '.[0].backup | length')"
test "$first_backup_count" = 1
enabled_object_count="$(object_count)"
test "$enabled_object_count" -gt 0

# Disable stops future archival and preserves all repository objects.
start_postgres off
test "$(docker exec "$database" psql -U postgres -Atqc 'show archive_mode')" = off
disabled_object_count="$(object_count)"
test "$disabled_object_count" = "$enabled_object_count"

# Inject a real MinIO outage at check and execute the enable compensation.
start_postgres on
docker stop "$minio" >/dev/null
if docker exec --user postgres "$database" pgbackrest --stanza=contract check >"$config_dir/check.out" 2>"$config_dir/check.err"; then
  printf 'pgBackRest check unexpectedly passed while MinIO was stopped\n' >&2
  exit 1
fi
start_postgres off
test "$(docker exec "$database" psql -U postgres -Atqc 'show archive_mode')" = off
docker start "$minio" >/dev/null
for _ in $(seq 1 60); do if mc 'mc stat contract/backup-contract >/dev/null'; then break; fi; sleep 1; done
test "$(object_count)" = "$enabled_object_count"

# IFN-45: a real MinIO read-only identity can inspect/restore metadata but cannot backup.
mc "mc admin user add contract '$readonly_key' '$readonly_secret' >/dev/null"
mc 'mc admin policy create contract contract-readonly /contract/readonly.json >/dev/null'
mc "mc admin policy attach contract contract-readonly --user '$readonly_key' >/dev/null"
write_config minio "$readonly_key" "$readonly_secret" "$config_dir/readonly.conf"
docker cp "$config_dir/readonly.conf" "$database:/tmp/readonly.conf"
docker exec --user root "$database" chmod 644 /tmp/readonly.conf
docker exec --user postgres "$database" pgbackrest --config=/tmp/readonly.conf --stanza=contract --output=json info >/dev/null
if docker exec --user postgres "$database" pgbackrest --config=/tmp/readonly.conf --stanza=contract --type=diff backup >"$config_dir/readonly.out" 2>"$config_dir/readonly.err"; then
  printf 'read-only MinIO identity unexpectedly created a backup\n' >&2
  exit 1
fi

# A rate-limiting proxy returns an observed HTTP 429 in front of the same MinIO repository.
docker run -d --name "$throttle" --network "$network" --network-alias minio-throttle \
  -v "$config_dir:/contract:ro" -v "$config_dir/nginx.conf:/etc/nginx/conf.d/default.conf:ro" nginx:1.27-alpine >/dev/null
sleep 1
write_config minio-throttle "$access_key" "$secret_key" "$config_dir/throttled.conf"
docker cp "$config_dir/throttled.conf" "$database:/tmp/throttled.conf"
docker exec --user root "$database" chmod 644 /tmp/throttled.conf
# Saturate the one-request token bucket from the same database client before
# pgBackRest retries through it. Unauthorized probe responses are acceptable;
# the contract assertion below requires the limiter itself to emit HTTP 429.
docker exec "$database" sh -c 'for i in $(seq 1 12); do curl -sk https://minio-throttle:9000/ >/dev/null & done; wait' || true
if docker exec --user postgres "$database" pgbackrest --config=/tmp/throttled.conf --stanza=contract check >"$config_dir/throttle.out" 2>"$config_dir/throttle.err"; then
  printf 'rate-limited pgBackRest check unexpectedly passed\n' >&2
  exit 1
fi
docker logs "$throttle" >"$config_dir/throttle.log" 2>&1
grep -Eq ' 429 ' "$config_dir/throttle.log"

# Simulate loss of the Agent result after a completed side effect, then reconcile
# against typed repository facts instead of issuing a duplicate backup.
start_postgres on
docker exec "$database" psql -U postgres -v ON_ERROR_STOP=1 -c "insert into drill_marker values (2, 'result-loss'); select pg_switch_wal();" >/dev/null
before_result_loss="$first_backup_count"
docker exec --user postgres "$database" pgbackrest --stanza=contract --type=diff backup >/dev/null
# The command result is intentionally discarded here.
after_result_loss="$(docker exec --user postgres "$database" pgbackrest --stanza=contract --output=json info | jq '.[0].backup | length')"
test "$after_result_loss" -eq $((before_result_loss + 1))

printf '{"contract":"IFN-44/45","result":"PASS","pitrEnable":{"restart":true,"stanzaCreate":true,"check":true,"walSwitch":true,"firstFull":true},"disable":{"archiveMode":"off","repositoryPreserved":true},"compensation":{"minioOutageObserved":true,"archiveMode":"off","repositoryPreserved":true},"minio":{"readOnlyInfo":true,"readOnlyBackupRejected":true,"throttle429Observed":true,"lostResultReconciled":true,"backupCount":%s,"objectCount":%s}}\n' "$after_result_loss" "$enabled_object_count"
