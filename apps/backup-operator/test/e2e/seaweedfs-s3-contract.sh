#!/usr/bin/env bash
set -Eeuo pipefail

# IFN-45: pgBackRest S3 contract against an implementation that is independent
# of MinIO. The test writes a full backup to SeaweedFS, destroys PGDATA, restores
# it from the read-only repository mount, and verifies the durable fixture.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
prefix="backup-seaweedfs-contract-$$"
postgres_image="${prefix}:postgres"
seaweed_image="chrislusf/seaweedfs:3.89"
network="${prefix}-net"
seaweed="${prefix}-seaweed"
tls_proxy="${prefix}-tls-proxy"
database="${prefix}-database"
data_volume="${prefix}-data"
seaweed_volume="${prefix}-seaweed-data"
work="$(mktemp -d)"

cleanup() {
  docker rm -f "$database" "$tls_proxy" "$seaweed" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  docker volume rm "$data_volume" "$seaweed_volume" >/dev/null 2>&1 || true
  docker image rm "$postgres_image" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT
on_error() {
  local line="$1"
  printf 'CONTRACT_FAILURE_LINE=%s\n' "$line" >&2
  docker logs --tail 120 "$database" >&2 2>/dev/null || true
  docker logs --tail 80 "$tls_proxy" >&2 2>/dev/null || true
  docker logs --tail 80 "$seaweed" >&2 2>/dev/null || true
}
trap 'on_error "$LINENO"' ERR

wait_http() {
  for _ in $(seq 1 90); do
    if docker run --rm --network "$network" curlimages/curl:8.12.1 -fsS \
      http://seaweedfs:9333/cluster/status >/dev/null 2>&1 \
      && docker run --rm --network "$network" curlimages/curl:8.12.1 -sS \
        http://seaweedfs:8333/ >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  docker logs "$seaweed" >&2
  return 1
}

wait_postgres() {
  for _ in $(seq 1 90); do
    if docker exec "$database" pg_isready -U postgres -d postgres >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  docker logs "$database" >&2
  return 1
}

docker build -t "$postgres_image" "$root/spikes/patroni" >/dev/null
docker network create "$network" >/dev/null
docker volume create "$data_volume" >/dev/null
docker volume create "$seaweed_volume" >/dev/null
docker run -d --name "$seaweed" --network "$network" --network-alias seaweedfs \
  -v "$seaweed_volume:/data" "$seaweed_image" \
  server -dir=/data -s3 -s3.port=8333 -volume.max=1 >/dev/null
wait_http

mkdir -p "$work/certs"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=seaweed-s3' \
  -addext 'subjectAltName=DNS:seaweed-s3' \
  -keyout "$work/certs/private.key" -out "$work/certs/public.crt" >/dev/null 2>&1
cat >"$work/nginx.conf" <<'EOF'
server {
  listen 9000 ssl;
  client_max_body_size 0;
  ssl_certificate /contract/certs/public.crt;
  ssl_certificate_key /contract/certs/private.key;
  location / {
    proxy_set_header Host $http_host;
    proxy_pass http://seaweedfs:8333;
  }
}
EOF
docker run -d --name "$tls_proxy" --network "$network" --network-alias seaweed-s3 \
  -v "$work:/contract:ro" -v "$work/nginx.conf:/etc/nginx/conf.d/default.conf:ro" \
  nginx:1.27-alpine >/dev/null

# SeaweedFS without an IAM config intentionally accepts anonymous S3 requests.
# pgBackRest still requires non-empty S3 credential fields, so fixed test-only
# values are supplied and never leave this isolated network.
docker run --rm --network "$network" --entrypoint /bin/sh minio/mc:RELEASE.2025-04-16T18-13-26Z -ec \
  'mc alias set seaweed http://seaweedfs:8333 contract-key contract-secret >/dev/null && mc mb --ignore-existing seaweed/backup-contract >/dev/null && mc stat seaweed/backup-contract >/dev/null'

cat >"$work/pgbackrest.conf" <<'EOF'
[global]
repo1-type=s3
repo1-s3-bucket=backup-contract
repo1-s3-endpoint=seaweed-s3
repo1-s3-port=9000
repo1-s3-region=us-east-1
repo1-s3-key=contract-key
repo1-s3-key-secret=contract-secret
repo1-s3-uri-style=path
repo1-storage-verify-tls=n
repo1-retention-full=2
archive-timeout=30
start-fast=y

[seaweed-contract]
pg1-path=/var/lib/postgresql/pgdata
pg1-user=postgres
EOF
chmod 600 "$work/pgbackrest.conf"

docker run --rm --user root -v "$data_volume:/var/lib/postgresql" --entrypoint chown \
  "$postgres_image" -R postgres:postgres /var/lib/postgresql >/dev/null
docker run --rm --user postgres -v "$data_volume:/var/lib/postgresql" --entrypoint initdb \
  "$postgres_image" -D /var/lib/postgresql/pgdata --data-checksums >/dev/null
docker run -d --name "$database" --network "$network" --user postgres \
  -v "$data_volume:/var/lib/postgresql" \
  -v "$work/pgbackrest.conf:/etc/pgbackrest/pgbackrest.conf:ro" \
  --entrypoint postgres "$postgres_image" -D /var/lib/postgresql/pgdata \
  -c listen_addresses='' -c archive_mode=on \
  -c 'archive_command=pgbackrest --stanza=seaweed-contract archive-push %p' >/dev/null
wait_postgres

docker exec --user postgres "$database" pgbackrest --stanza=seaweed-contract stanza-create
docker exec --user postgres "$database" pgbackrest --stanza=seaweed-contract check
docker exec "$database" psql -U postgres -v ON_ERROR_STOP=1 -c \
  "create table seaweed_fixture(id int primary key, value text not null); insert into seaweed_fixture values (1, 'seaweedfs-restored'); select pg_switch_wal();" >/dev/null
docker exec --user postgres "$database" pgbackrest --stanza=seaweed-contract --type=full backup
backup_label="$(docker exec --user postgres "$database" pgbackrest --stanza=seaweed-contract --output=json info | jq -r '.[0].backup[-1].label')"
test -n "$backup_label"

docker rm -f "$database" >/dev/null
docker run --rm --user root -v "$data_volume:/var/lib/postgresql" --entrypoint sh "$postgres_image" -ec \
  'rm -rf /var/lib/postgresql/pgdata && install -d -o postgres -g postgres /var/lib/postgresql/pgdata'
docker run --rm --network "$network" --user postgres \
  -v "$data_volume:/var/lib/postgresql" \
  -v "$work/pgbackrest.conf:/etc/pgbackrest/pgbackrest.conf:ro" \
  --entrypoint pgbackrest "$postgres_image" --stanza=seaweed-contract --repo=1 restore >/dev/null
docker run -d --name "$database" --network "$network" --user postgres \
  -v "$data_volume:/var/lib/postgresql" \
  -v "$work/pgbackrest.conf:/etc/pgbackrest/pgbackrest.conf:ro" \
  --entrypoint postgres "$postgres_image" \
  -D /var/lib/postgresql/pgdata -c listen_addresses='' -c archive_mode=off >/dev/null
wait_postgres
restored="$(docker exec "$database" psql -U postgres -Atqc 'select value from seaweed_fixture where id=1')"
test "$restored" = seaweedfs-restored

seaweed_id="$(docker image inspect "$seaweed_image" --format '{{.Id}}')"
postgres_id="$(docker image inspect "$postgres_image" --format '{{.Id}}')"
printf 'implementation=seaweedfs\n'
printf 'seaweedfs_version=3.89\n'
printf 'seaweedfs_image_id=%s\n' "$seaweed_id"
printf 'postgres_image_id=%s\n' "$postgres_id"
printf 'backup_label=%s\n' "$backup_label"
printf 'restore_fixture=%s\n' "$restored"
printf 'RESULT=PASS\n'
