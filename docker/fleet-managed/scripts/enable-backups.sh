#!/usr/bin/env bash
# Enables pgBackRest backups for one Fleet-managed stack. Run it from the
# repository's `docker` directory with the stack's usual Compose arguments:
#
#   fleet-managed/scripts/enable-backups.sh project-a -- \
#     -p supabase-managed-a --env-file self-platform/.env \
#     --env-file fleet-managed/project-a.env \
#     -f docker-compose.yml -f fleet-managed/docker-compose.override.yml ...
#
# The script appends fleet-managed/docker-compose.backup.yml. Every step is
# idempotent, so a failed run can be repeated. `db` is stopped while the data
# volume layout is migrated and restarted once more to turn on WAL archiving.
#
# It then enrolls the stack's backup Agent with the control plane's Backup
# Operator, so it must run on the control-plane host: it signs the Agent's
# certificate with the backup Agent CA and recreates the Operator. Set
# FLEET_CONTROL_COMPOSE_PROJECT when the control plane's Compose project name is
# not the default (`self-platform`).
set -Eeuo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_docker_dir="$(cd "$root_dir/.." && pwd)"
control_env="${FLEET_CONTROL_ENV:-$repo_docker_dir/self-platform/control-plane.env}"
repository_ca="${BACKUP_REPOSITORY_CA:-$repo_docker_dir/self-platform/secrets/fleet-management/ca.crt}"
repository_endpoint="${BACKUP_REPOSITORY_ENDPOINT:-backup-repository}"
repository_port="${BACKUP_REPOSITORY_PORT:-9000}"
management_network="${FLEET_MANAGEMENT_NETWORK_NAME:-fleet-management}"
rc_image="${BACKUP_REPOSITORY_CLIENT_IMAGE:-rustfs/rc:v0.1.36}"
agent_image="${FLEET_BACKUP_AGENT_IMAGE:-supabase-backup-agent:local}"
control_dir="$repo_docker_dir/self-platform"
control_project="${FLEET_CONTROL_COMPOSE_PROJECT:-self-platform}"
agent_ca_dir="$control_dir/secrets/backup-operator/tls"
cluster_dir="$control_dir/secrets/backup-operator/clusters"
# The image's /usr/bin/pgbackrest wrapper drops --config and switches to another
# user with sudo. The Agent and archive-push run the real binary as postgres.
pgbackrest_binary=/usr/lib/pgbackrest/bin/pgbackrest.real
pgbackrest_config=/etc/pgbackrest/pgbackrest.conf

usage() { echo "usage: $0 <project-ref> -- <docker compose arguments>" >&2; exit 2; }
fail() { echo "ERROR: $*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }

project_ref="${1:-}"
[ "${2:-}" = "--" ] || usage
shift 2
[ "$#" -gt 0 ] || usage
[[ "$project_ref" =~ ^[a-z0-9][a-z0-9-]{0,49}$ ]] || fail "project ref must be 1-50 lowercase letters, digits, or hyphens"
[ -f "$control_env" ] || fail "control-plane environment is missing: $control_env"
[ -f "$repository_ca" ] || fail "repository CA is missing: $repository_ca"
[ -f "$agent_ca_dir/ca.key" ] || fail "backup Agent CA is missing; run self-platform/scripts/generate-backup-agent-trust.sh"

compose_args=("$@" -f "$root_dir/docker-compose.backup.yml")
compose() { docker compose "${compose_args[@]}" "$@"; }

# The project env file is the last --env-file argument; it records the backup settings.
project_env=""
for ((i = 1; i < ${#compose_args[@]}; i++)); do
  [ "${compose_args[i - 1]}" = "--env-file" ] && project_env="${compose_args[i]}"
done
[ -n "$project_env" ] && [ -f "$project_env" ] || fail "pass the project env file with --env-file"
compose_project=""
for ((i = 1; i < ${#compose_args[@]}; i++)); do
  [ "${compose_args[i - 1]}" = "-p" ] && compose_project="${compose_args[i]}"
done
[ -n "$compose_project" ] || fail "pass the stack's Compose project name with -p"
envval_from() { grep -E "^$2=" "$1" | head -1 | cut -d= -f2- | tr -d '\r'; }
[ "$(envval_from "$project_env" MANAGED_PROJECT_REF)" = "$project_ref" ] ||
  fail "$project_env does not belong to $project_ref"

stanza="$project_ref"
bucket="fleet-backup-$project_ref"
repository_user="backup-$project_ref"
repository_policy="backup-$project_ref-rw"
config_dir="$root_dir/state/$project_ref/backup"
config_file="$config_dir/pgbackrest.conf"
archive_command="$pgbackrest_binary --config=$pgbackrest_config --stanza=$stanza archive-push %p"

umask 077
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

step "Writing the pgBackRest configuration"
mkdir -p "$config_dir"
chmod 0700 "$config_dir"
if [ -f "$config_file" ]; then
  repository_secret="$(envval_from "$config_file" repo1-s3-key-secret)"
  [ -n "$repository_secret" ] || fail "$config_file has no repository secret"
  echo "Keeping the existing configuration"
else
  repository_secret="$(openssl rand -hex 32)"
  cat >"$work/pgbackrest.conf" <<EOF
[global]
repo1-type=s3
repo1-path=/pgbackrest
repo1-s3-bucket=$bucket
repo1-s3-endpoint=$repository_endpoint
repo1-s3-port=$repository_port
repo1-s3-region=us-east-1
repo1-s3-uri-style=path
repo1-s3-key=$repository_user
repo1-s3-key-secret=$repository_secret
repo1-storage-ca-file=/etc/pgbackrest/ca.crt
repo1-cipher-type=aes-256-cbc
repo1-cipher-pass=$(openssl rand -hex 32)
repo1-retention-full=2
compress-type=zst
start-fast=y
archive-timeout=60
log-level-console=info
log-level-file=off

[$stanza]
pg1-path=/var/lib/postgresql/data
pg1-socket-path=/var/run/postgresql
pg1-port=5432
pg1-user=supabase_admin
EOF
  install -m 0600 "$work/pgbackrest.conf" "$config_file"
fi
install -m 0644 "$repository_ca" "$config_dir/ca.crt"
set_project_env() {
  if grep -qE "^$1=" "$project_env"; then
    [ "$(envval_from "$project_env" "$1")" = "$2" ] || fail "$project_env sets $1 to a different value"
  else
    printf '%s=%s\n' "$1" "$2" >>"$project_env"
  fi
}
set_project_env FLEET_BACKUP_CONFIG_ROOT "./fleet-managed/state/$project_ref/backup"
grep -qE '^FLEET_BACKUP_AGENT_IMAGE=' "$project_env" || set_project_env FLEET_BACKUP_AGENT_IMAGE "$agent_image"
# The gateway container is named by the Kong or Envoy overlay in use.
gateway_container="$(compose ps --all --format '{{.Name}}' kong | head -1)"
[ -n "$gateway_container" ] || fail "the stack's gateway (service kong) is not created"
set_project_env FLEET_BACKUP_GATEWAY_CONTAINER "$gateway_container"

step "Creating bucket $bucket and its credentials"
{
  printf 'ROOT_USER=%s\n' "$(envval_from "$control_env" BACKUP_REPOSITORY_ROOT_USER)"
  printf 'ROOT_PASSWORD=%s\n' "$(envval_from "$control_env" BACKUP_REPOSITORY_ROOT_PASSWORD)"
  printf 'BUCKET=%s\nUSER_NAME=%s\nUSER_SECRET=%s\nPOLICY=%s\n' \
    "$bucket" "$repository_user" "$repository_secret" "$repository_policy"
} >"$work/rc.env"
cat >"$work/policy.json" <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:*"],"Resource":["arn:aws:s3:::$bucket","arn:aws:s3:::$bucket/*"]}]}
EOF
docker run --rm --network "$management_network" --env-file "$work/rc.env" \
  -v "$work/policy.json:/policy.json:ro" -v "$repository_ca:/ca.crt:ro" -e SSL_CERT_FILE=/ca.crt \
  --entrypoint /bin/sh "$rc_image" -ceu "
    rc alias set root https://$repository_endpoint:$repository_port \"\$ROOT_USER\" \"\$ROOT_PASSWORD\" >/dev/null
    rc mb --ignore-existing \"root/\$BUCKET\"
    rc admin policy info root \"\$POLICY\" >/dev/null 2>&1 || rc admin policy create root \"\$POLICY\" /policy.json
    if rc admin user info root \"\$USER_NAME\" >/dev/null 2>&1; then
      echo \"User \$USER_NAME exists\"
    else
      rc admin user add root \"\$USER_NAME\" \"\$USER_SECRET\"
    fi
    rc admin policy attach root \"\$POLICY\" --user \"\$USER_NAME\" >/dev/null 2>&1 || true
    rc admin policy entities root --user \"\$USER_NAME\" | grep -q \"\$POLICY\"
  "

step "Migrating the data volume layout"
if compose --profile backup-migrate run --rm --no-deps --entrypoint /bin/sh db-layout-migrate \
  -c 'test -f /volume/.fleet-pgdata-layout'; then
  echo "Already migrated"
else
  system_identifier="$(compose exec -T db psql -U supabase_admin -h /var/run/postgresql -d postgres -Atc \
    'select system_identifier from pg_control_system()')"
  compose stop db
  compose --profile backup-migrate run --rm --no-deps db-layout-migrate
  compose up -d --wait db
  migrated_identifier="$(compose exec -T db psql -U supabase_admin -h /var/run/postgresql -d postgres -Atc \
    'select system_identifier from pg_control_system()')"
  [ "$migrated_identifier" = "$system_identifier" ] ||
    fail "system identifier changed from $system_identifier to $migrated_identifier"
fi
# Recreates `db` with the backup overlay and refreshes the copied configuration.
compose up -d --wait db

pgbackrest() { compose run --rm --entrypoint "$pgbackrest_binary" backup-agent --stanza="$stanza" "$@"; }

step "Creating stanza $stanza"
pgbackrest stanza-create

step "Turning on WAL archiving"
# Without a timeout an idle database never completes a WAL segment, so the
# recovery window would stop advancing. 120 seconds matches the Supabase image.
compose exec -T db psql -U supabase_admin -h /var/run/postgresql -d postgres -v ON_ERROR_STOP=1 -Atc \
  "ALTER SYSTEM SET archive_timeout = '120s'" -c "SELECT pg_reload_conf()" >/dev/null
current="$(compose exec -T db psql -U supabase_admin -h /var/run/postgresql -d postgres -Atc \
  "select current_setting('archive_mode') || '|' || current_setting('archive_command')")"
if [ "$current" = "on|$archive_command" ]; then
  echo "Already on"
else
  compose exec -T db psql -U supabase_admin -h /var/run/postgresql -d postgres -v ON_ERROR_STOP=1 \
    -v cmd="$archive_command" <<'SQL'
ALTER SYSTEM SET archive_mode = 'on';
ALTER SYSTEM SET archive_command = :'cmd';
SQL
  compose restart db
  compose up -d --wait db
fi

step "Checking the stanza and taking the first full backup"
pgbackrest check
if pgbackrest --output=json info | grep -q '"type":"full"'; then
  echo "A full backup already exists"
else
  pgbackrest --type=full backup
fi
pgbackrest info

step "Enrolling the backup Agent"
agent_id="backup-agent-$project_ref"
if [ ! -f "$config_dir/agent.key" ]; then
  openssl ecparam -name prime256v1 -genkey -noout -out "$work/agent.key"
  openssl req -new -sha256 -key "$work/agent.key" -subj "/CN=$agent_id" -out "$work/agent.csr"
  printf '%s\n' "subjectAltName=DNS:$agent_id" 'extendedKeyUsage=clientAuth' \
    'keyUsage=digitalSignature,keyEncipherment' >"$work/agent.ext"
  openssl x509 -req -sha256 -in "$work/agent.csr" -CA "$agent_ca_dir/ca.crt" -CAkey "$agent_ca_dir/ca.key" \
    -CAserial "$work/ca.srl" -CAcreateserial -days 825 -extfile "$work/agent.ext" -out "$work/agent.crt" 2>/dev/null
  install -m 0644 "$work/agent.crt" "$config_dir/agent.crt"
  install -m 0600 "$work/agent.key" "$config_dir/agent.key"
fi
install -m 0644 "$agent_ca_dir/ca.crt" "$config_dir/operator-ca.crt"
fingerprint="sha256:$(openssl x509 -in "$config_dir/agent.crt" -outform der | openssl dgst -sha256 | awk '{print $NF}')"
system_identifier="$(compose exec -T db psql -U supabase_admin -h /var/run/postgresql -d postgres -Atc \
  'select system_identifier from pg_control_system()')"
revision="sha256:$(openssl dgst -sha256 "$config_file" | awk '{print $NF}')"
mkdir -p "$cluster_dir"
cat >"$work/cluster.json" <<JSON
{
  "projectId": "$project_ref",
  "targetId": "$project_ref",
  "nodeId": "$project_ref-db",
  "agentId": "$agent_id",
  "certificateFingerprint": "$fingerprint",
  "systemIdentifier": "$system_identifier",
  "dataDomain": "${compose_project}_managed-db-data",
  "stanza": "$stanza",
  "pgbackrestBinary": "$pgbackrest_binary",
  "pgbackrestConfig": "$pgbackrest_config",
  "repositoryId": "$bucket",
  "repositoryType": "s3",
  "repositoryEndpoint": "$repository_endpoint:$repository_port",
  "repositoryLocation": "s3://$bucket/pgbackrest",
  "repositoryFingerprint": "s3:$repository_endpoint/$bucket",
  "repositoryRevision": "$revision"
}
JSON
install -m 0600 "$work/cluster.json" "$cluster_dir/$project_ref.json"
control_compose() {
  docker compose -p "$control_project" --env-file "$control_env" -f "$control_dir/docker-compose.control-plane.yml" "$@"
}
control_compose up -d --force-recreate --no-deps backup-operator-config-init
control_compose up -d --force-recreate --no-deps backup-operator

step "Starting the backup Agent"
compose --profile backup-validation create db-validation
compose --profile backup-agent up -d backup-config-init fleet-docker-proxy-backup backup-agent
echo "The Operator asks the Agent for its first observation within a minute."
echo "Repository ID for the backup policy: $bucket"
