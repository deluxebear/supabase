#!/usr/bin/env bash
set -Eeuo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_env="${1:-$root_dir/.env}"
output_env="${2:-$root_dir/control-plane.env}"

[ -f "$source_env" ] || {
  echo "ERROR: source environment file is missing: $source_env" >&2
  exit 1
}
if [ -e "$output_env" ]; then
  echo "Control-plane environment already exists: $output_env"
  exit 0
fi

envval() { grep -E "^$1=" "$source_env" | head -1 | cut -d= -f2- | tr -d '\r'; }
random_secret() { openssl rand -hex 32; }

admin_email="$(envval PLATFORM_ADMIN_EMAIL)"
admin_password="$(envval PLATFORM_ADMIN_PASSWORD)"
source_public_url="$(envval SUPABASE_PUBLIC_URL)"
[ -n "$admin_email" ] && [ -n "$admin_password" ] && [ -n "$source_public_url" ] || {
  echo "ERROR: source environment must configure platform admin credentials and SUPABASE_PUBLIC_URL" >&2
  exit 1
}

source_origin="$(SOURCE_PUBLIC_URL="$source_public_url" node -e \
  'const url = new URL(process.env.SOURCE_PUBLIC_URL); url.port = ""; process.stdout.write(url.origin)')"
fleet_public_url="${FLEET_PUBLIC_URL:-$source_origin:8001}"
temporary="$(mktemp "${output_env}.tmp.XXXXXX")"
trap 'rm -f "$temporary"' EXIT
umask 077

{
  printf 'FLEET_PUBLIC_URL=%s\n' "$fleet_public_url"
  printf 'FLEET_HTTP_PORT=8001\n'
  printf 'FLEET_STUDIO_IMAGE=supabase-studio:fleet-simulation\n'
  printf 'FLEET_MANAGEMENT_NETWORK_NAME=fleet-management\n'
  printf 'PLATFORM_ADMIN_EMAIL=%s\n' "$admin_email"
  printf 'PLATFORM_ADMIN_PASSWORD=%s\n' "$admin_password"
  printf 'PLATFORM_POSTGRES_PASSWORD=%s\n' "$(random_secret)"
  printf 'PLATFORM_OUTBOX_DISPATCHER_PASSWORD=%s\n' "$(random_secret)"
  printf 'FLEET_CONTROL_POSTGRES_PASSWORD=%s\n' "$(random_secret)"
  printf 'BACKUP_OPERATOR_POSTGRES_PASSWORD=%s\n' "$(random_secret)"
  printf 'PLATFORM_JWT_SECRET=%s\n' "$(random_secret)"
  printf 'PLATFORM_ENCRYPTION_KEY=%s\n' "$(random_secret)"
  printf 'PG_META_CRYPTO_KEY=%s\n' "$(random_secret)"
  printf 'FLEET_CONTROL_IMAGE=supabase-fleet-control:simulation\n'
  printf 'FLEET_CONTROL_VERSION=simulation\n'
  printf 'FLEET_CONTROL_SERVICE_ASSERTION_KEY=%s\n' "$(random_secret)"
  printf 'FLEET_CONTROL_SERVICE_ASSERTION_ISSUER=studio-platform\n'
  printf 'FLEET_CONTROL_SERVICE_ASSERTION_AUDIENCE=fleet-control\n'
  printf 'FLEET_CONTROL_HTTP_PORT=8090\n'
  printf 'FLEET_CONTROL_ENROLLMENT_HTTPS_PORT=8091\n'
  printf 'FLEET_CONTROL_AGENT_GRPC_PORT=8092\n'
  printf 'FLEET_CONTROL_AGENT_TRUST_DOMAIN=fleet.internal\n'
  printf 'FLEET_CONTROL_AGENT_CERTIFICATE_TTL=24h\n'
  printf 'FLEET_CONTROL_ENROLLMENT_TOKEN_TTL=10m\n'
  printf 'FLEET_CONTROL_CERTIFICATE_OVERLAP=5m\n'
  printf 'FLEET_CONTROL_STORE_SYSTEM_IDENTIFIER=fleet-control\n'
  printf 'FLEET_CONTROL_STORE_DATA_DOMAIN=fleet-control-db-data\n'
  printf 'FLEET_CONTROL_ARTIFACT_ROOT=/var/lib/fleet-artifacts\n'
  printf 'FLEET_CONTROL_MAX_AGENT_SESSIONS=300\n'
  printf 'FLEET_CONTROL_MAX_CONCURRENT_OPERATIONS=20\n'
  printf 'FLEET_CONTROL_MAX_CONCURRENT_OPERATIONS_PER_TARGET=2\n'
  printf 'FLEET_CONTROL_MAX_QUEUED_PER_ORGANIZATION=1000\n'
  printf 'FLEET_CONTROL_MAX_QUEUED_PER_TARGET=100\n'
  printf 'FLEET_CONTROL_MAX_ARTIFACT_BYTES_PER_PROJECT=1073741824\n'
  printf 'FLEET_CONTROL_MAX_ARTIFACT_BYTES_PER_ORGANIZATION=21474836480\n'
  printf 'FLEET_CONTROL_MAX_EVENTS_PER_OPERATION=10000\n'
  printf 'FLEET_CONTROL_RETENTION_INTERVAL=5m\n'
  printf 'FLEET_CONTROL_TERMINAL_EVENT_RETENTION=720h\n'
  printf 'FLEET_CONTROL_AUDIT_RETENTION=8760h\n'
  printf 'FLEET_CONTROL_RETENTION_BATCH_SIZE=10000\n'
  printf 'SELF_PLATFORM_METRICS_CONCURRENCY=8\n'
  printf 'FLEET_LIFECYCLE_COMPONENT_VERSIONS=\n'
  printf 'FLEET_OUTBOX_WORKER_ID=fleet-outbox-1\n'
  printf 'FLEET_OUTBOX_LEASE=30s\n'
  printf 'FLEET_OUTBOX_POLL_INTERVAL=2s\n'
  printf 'BACKUP_OPERATOR_IMAGE=supabase-backup-operator:simulation\n'
  printf 'BACKUP_OPERATOR_VERSION=simulation\n'
  printf 'BACKUP_OPERATOR_SERVICE_ASSERTION_KEY=unused-separate-key\n'
  printf 'BACKUP_OPERATOR_SERVICE_ASSERTION_ISSUER=studio-platform\n'
  printf 'BACKUP_OPERATOR_SERVICE_ASSERTION_AUDIENCE=backup-operator\n'
  printf 'BACKUP_OPERATOR_HTTP_PORT=8080\n'
  printf 'BACKUP_OPERATOR_CONTROL_STORE_SYSTEM_IDENTIFIER=fleet-backup-control\n'
  printf 'BACKUP_OPERATOR_CONTROL_STORE_DATA_DOMAIN=backup-operator-db-data\n'
  printf 'BACKUP_OPERATOR_RUNTIME_MAX_CONCURRENT_OPERATIONS=4\n'
  printf 'MANAGED_SUPABASE_URL=\n'
  printf 'MANAGED_ANON_KEY=\n'
  printf 'MANAGED_SERVICE_ROLE_KEY=\n'
  printf 'MANAGED_JWT_SECRET=\n'
} > "$temporary"

chmod 0600 "$temporary"
mv "$temporary" "$output_env"
trap - EXIT
echo "Created control-plane environment at $output_env"
