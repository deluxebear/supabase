#!/usr/bin/env bash
set -Eeuo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repo_docker_dir="$(cd "$root_dir/.." && pwd)"
source_env="${SOURCE_SUPABASE_ENV:-$repo_docker_dir/self-platform/.env}"
control_env="${FLEET_CONTROL_ENV:-$repo_docker_dir/self-platform/control-plane.env}"
project_ref="${1:-project-a}"
output_env="${2:-$root_dir/$project_ref.env}"
http_port="${MANAGED_KONG_HTTP_PORT:-8200}"
https_port="${MANAGED_KONG_HTTPS_PORT:-8543}"
db_direct_port="${MANAGED_DB_DIRECT_HOST_PORT:-55433}"
postgres_port="${MANAGED_POSTGRES_HOST_PORT:-55432}"
pooler_port="${MANAGED_POOLER_HOST_PORT:-56543}"

[[ "$project_ref" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || {
  echo "ERROR: project ref must contain lowercase letters, digits, or hyphens" >&2
  exit 1
}
[ -f "$source_env" ] || { echo "ERROR: source Supabase environment is missing: $source_env" >&2; exit 1; }
if [ -e "$output_env" ]; then
  echo "Managed instance environment already exists: $output_env"
  exit 0
fi

envval_from() { grep -E "^$2=" "$1" | head -1 | cut -d= -f2- | tr -d '\r'; }
envval() { envval_from "$source_env" "$1"; }
source_public_url="$(envval SUPABASE_PUBLIC_URL)"
[ -n "$source_public_url" ] || { echo "ERROR: SUPABASE_PUBLIC_URL is missing from $source_env" >&2; exit 1; }
source_origin="$(SOURCE_PUBLIC_URL="$source_public_url" node -e \
  'const url = new URL(process.env.SOURCE_PUBLIC_URL); url.port = ""; process.stdout.write(url.origin)')"
public_url="$source_origin:$http_port"
project_key="$(printf '%s' "$project_ref" | shasum -a 256 | cut -c1-24)"
pg_meta_crypto_key="$(
  if [ -f "$control_env" ]; then
    envval_from "$control_env" PG_META_CRYPTO_KEY
  else
    envval PG_META_CRYPTO_KEY
  fi
)"
[ -n "$pg_meta_crypto_key" ] || {
  echo "ERROR: PG_META_CRYPTO_KEY is missing from $control_env and $source_env" >&2
  exit 1
}
lifecycle_versions="$(
  if [ -f "$control_env" ]; then
    envval_from "$control_env" FLEET_LIFECYCLE_COMPONENT_VERSIONS || true
  fi
)"
output_env_abs="$(cd "$(dirname "$output_env")" && pwd)/$(basename "$output_env")"
source_env_abs="$(cd "$(dirname "$source_env")" && pwd)/$(basename "$source_env")"
temporary="$(mktemp "${output_env}.tmp.XXXXXX")"
trap 'rm -f "$temporary"' EXIT
umask 077

{
  printf 'MANAGED_PROJECT_REF=%s\n' "$project_ref"
  printf 'MANAGED_CONTAINER_PREFIX=supabase-managed-%s\n' "$project_ref"
  printf 'MANAGED_KONG_HTTP_PORT=%s\n' "$http_port"
  printf 'MANAGED_KONG_HTTPS_PORT=%s\n' "$https_port"
  printf 'MANAGED_DB_DIRECT_HOST_PORT=%s\n' "$db_direct_port"
  printf 'MANAGED_POSTGRES_HOST_PORT=%s\n' "$postgres_port"
  printf 'MANAGED_POOLER_HOST_PORT=%s\n' "$pooler_port"
  printf 'SUPABASE_PUBLIC_URL=%s\n' "$public_url"
  printf 'API_EXTERNAL_URL=%s/auth/v1\n' "$public_url"
  printf 'SITE_URL=%s\n' "$public_url"
  printf 'POOLER_TENANT_ID=%s\n' "$project_ref"
  # Each attached stack is an independent security boundary. Generate its
  # database, JWT, Realtime, Supavisor, Logflare and S3 credentials directly
  # into the mode-0600 environment file without ever printing them.
  node <<'NODE'
const crypto = require('node:crypto')
const base64url = (value) => Buffer.from(value).toString('base64url')
const random = (bytes) => crypto.randomBytes(bytes)
const jwtSecret = random(32).toString('base64url')
const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
const issuedAt = Math.floor(Date.now() / 1000)
const expiresAt = issuedAt + 5 * 365 * 24 * 60 * 60
const token = (role) => {
  const payload = base64url(JSON.stringify({ role, iss: 'supabase', iat: issuedAt, exp: expiresAt }))
  const signingInput = `${header}.${payload}`
  const signature = crypto.createHmac('sha256', jwtSecret).update(signingInput).digest('base64url')
  return `${signingInput}.${signature}`
}
const values = {
  POSTGRES_PASSWORD: random(24).toString('hex'),
  JWT_SECRET: jwtSecret,
  ANON_KEY: token('anon'),
  SERVICE_ROLE_KEY: token('service_role'),
  SECRET_KEY_BASE: random(48).toString('base64url'),
  REALTIME_DB_ENC_KEY: random(8).toString('hex'),
  VAULT_ENC_KEY: random(16).toString('hex'),
  LOGFLARE_PUBLIC_ACCESS_TOKEN: random(32).toString('base64url'),
  LOGFLARE_PRIVATE_ACCESS_TOKEN: random(32).toString('base64url'),
  S3_PROTOCOL_ACCESS_KEY_ID: random(16).toString('hex'),
  S3_PROTOCOL_ACCESS_KEY_SECRET: random(32).toString('hex'),
}
for (const [name, value] of Object.entries(values)) console.log(`${name}=${value}`)
NODE
  printf 'DASHBOARD_USERNAME=disabled\n'
  printf 'DASHBOARD_PASSWORD=disabled-embedded-studio\n'
  printf 'FLEET_MANAGEMENT_NETWORK_NAME=fleet-management\n'
  printf 'PG_META_CRYPTO_KEY=%s\n' "$pg_meta_crypto_key"
  printf 'FLEET_AGENT_IMAGE=supabase-fleet-control:simulation\n'
  printf 'FLEET_FUNCTION_PROJECT_KEY=%s\n' "$project_key"
  printf 'FLEET_FUNCTION_ROOT=./fleet-managed/state/%s/functions\n' "$project_ref"
  printf 'FLEET_CONFIG_ROOT=./fleet-managed/state/%s/config\n' "$project_ref"
  printf 'FLEET_AGENT_ENROLLMENT_TOKEN=\n'
  printf 'FLEET_AGENT_ORGANIZATION_ID=\n'
  printf 'FLEET_AGENT_TARGET_ID=\n'
  printf 'FLEET_AGENT_BINDING_ID=\n'
  printf 'FLEET_AGENT_EXECUTION_TARGET=compose-%s\n' "$project_ref"
  printf 'FLEET_AGENT_ID=agent-%s\n' "$project_ref"
  printf 'FLEET_AGENT_NODE_ID=node-%s\n' "$project_ref"
  # Used only by docker-compose.lifecycle.yml (opt-in runtime.restart/rollout).
  printf 'FLEET_HOST_COMPOSE_DIRECTORY=%s\n' "$repo_docker_dir"
  printf 'FLEET_LIFECYCLE_SOURCE_ENV_FILE=%s\n' "$source_env_abs"
  printf 'FLEET_LIFECYCLE_PROJECT_ENV_FILE=%s\n' "$output_env_abs"
  printf 'FLEET_LIFECYCLE_BIND_PREFIXES=%s,%s\n' "$repo_docker_dir/volumes/pooler" "$root_dir/state/$project_ref/functions"
  printf 'FLEET_LIFECYCLE_COMPONENT_VERSIONS=%s\n' "$lifecycle_versions"
  printf 'FLEET_HOST_CONFIG_ROOT=%s\n' "$root_dir/state/$project_ref/config"
} > "$temporary"

chmod 0600 "$temporary"
mv "$temporary" "$output_env"
trap - EXIT
echo "Created managed instance environment at $output_env"
"$root_dir/scripts/bootstrap-config-domain.sh" "$root_dir/state/$project_ref/config" auth
