#!/usr/bin/env bash
# End-to-end Fleet acceptance against two real Docker-backed Supabase stacks.
#
# Stack A is the running docker/self-platform Compose deployment. Stack B is
# an independently managed Docker Compose deployment supplied through explicit
# TARGET_* variables. The test attaches B, proves routing/isolation/status
# contracts, detaches it, and then proves that detach did not stop or delete B.
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${FLEET_ENV_FILE:-$ROOT_DIR/.env}"
FLEET_API_BASE="${FLEET_API_BASE:-http://127.0.0.1:8100}"
FLEET_AUTH_BASE="${FLEET_AUTH_BASE:-$FLEET_API_BASE}"
TARGET_DB_CONTAINER="${TARGET_DB_CONTAINER:-}"
TARGET_KONG_CONTAINER="${TARGET_KONG_CONTAINER:-}"
TARGET_DB_HOST="${TARGET_DB_HOST:-}"
TARGET_DB_PORT="${TARGET_DB_PORT:-}"
TARGET_GATEWAY_URL="${TARGET_GATEWAY_URL:-}"
TARGET_DB_PASSWORD="${TARGET_DB_PASSWORD:-}"
TARGET_ANON_KEY="${TARGET_ANON_KEY:-}"
TARGET_SERVICE_ROLE_KEY="${TARGET_SERVICE_ROLE_KEY:-}"
TARGET_JWT_SECRET="${TARGET_JWT_SECRET:-}"
REF="${TARGET_PROJECT_REF:-compose-e2e-$(date +%H%M%S)}"

for command in curl docker jq node sed; do
  command -v "$command" >/dev/null || {
    echo "ERROR: required command '$command' is unavailable" >&2
    exit 1
  }
done
[ -f "$ENV_FILE" ] || {
  echo "ERROR: missing Fleet environment file: $ENV_FILE" >&2
  exit 1
}
for variable in TARGET_DB_CONTAINER TARGET_KONG_CONTAINER TARGET_DB_HOST \
  TARGET_DB_PORT TARGET_GATEWAY_URL TARGET_DB_PASSWORD TARGET_ANON_KEY \
  TARGET_SERVICE_ROLE_KEY TARGET_JWT_SECRET; do
  [ -n "${!variable}" ] || {
    echo "ERROR: required target setting '$variable' is missing" >&2
    exit 1
  }
done

# Upstream-style .env values may contain unquoted spaces, so do not source it.
envval() { grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- | tr -d '\r'; }
PLATFORM_ADMIN_EMAIL="$(envval PLATFORM_ADMIN_EMAIL)"
PLATFORM_ADMIN_PASSWORD="$(envval PLATFORM_ADMIN_PASSWORD)"
[ -n "$PLATFORM_ADMIN_EMAIL" ] && [ -n "$PLATFORM_ADMIN_PASSWORD" ] || {
  echo "ERROR: Fleet admin credentials are missing from $ENV_FILE" >&2
  exit 1
}

TMP_DIR="$(mktemp -d)"
ATTACHED=0
cfg_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
auth_header() { printf 'header = "Authorization: Bearer %s"\n' "$(cfg_escape "$TOKEN")"; }

cleanup() {
  if [ "$ATTACHED" -eq 1 ]; then
    auth_header | curl -sS -o /dev/null -K - -X DELETE \
      "$FLEET_API_BASE/api/platform/projects/$REF" || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

login_body=$(PLATFORM_ADMIN_EMAIL="$PLATFORM_ADMIN_EMAIL" \
  PLATFORM_ADMIN_PASSWORD="$PLATFORM_ADMIN_PASSWORD" \
  node -e 'process.stdout.write(JSON.stringify({email:process.env.PLATFORM_ADMIN_EMAIL,password:process.env.PLATFORM_ADMIN_PASSWORD}))')
{
  printf 'header = "Content-Type: application/json"\n'
  printf 'data = "%s"\n' "$(cfg_escape "$login_body")"
} | curl -fsS -K - -X POST \
  "$FLEET_AUTH_BASE/platform-auth/v1/token?grant_type=password" > "$TMP_DIR/login.json"
TOKEN=$(jq -r '.access_token // empty' "$TMP_DIR/login.json")
[ -n "$TOKEN" ] || { echo "ERROR: Fleet admin login failed" >&2; exit 1; }

DB_PASSWORD="$TARGET_DB_PASSWORD"
ANON_KEY="$TARGET_ANON_KEY"
SERVICE_ROLE_KEY="$TARGET_SERVICE_ROLE_KEY"
JWT_SECRET="$TARGET_JWT_SECRET"

export REF DB_PASSWORD ANON_KEY SERVICE_ROLE_KEY JWT_SECRET TARGET_DB_HOST \
  TARGET_DB_PORT TARGET_GATEWAY_URL
# shellcheck disable=SC2016 # JavaScript template interpolation runs inside Node.
attach_body=$(node -e '
const gateway = process.env.TARGET_GATEWAY_URL.replace(/\/$/, "")
process.stdout.write(JSON.stringify({
  mode: "external",
  organization_slug: "default",
  name: "Compose E2E B",
  ref: process.env.REF,
  connection: {
    dbHost: process.env.TARGET_DB_HOST,
    dbPort: Number(process.env.TARGET_DB_PORT),
    dbName: "postgres",
    dbUser: "postgres",
    dbUserReadonly: "supabase_read_only_user",
    dbPass: process.env.DB_PASSWORD,
    dbPassReadonly: process.env.DB_PASSWORD,
    kongUrl: gateway,
    restUrl: `${gateway}/rest/v1/`,
    anonKey: process.env.ANON_KEY,
    serviceKey: process.env.SERVICE_ROLE_KEY,
    jwtSecret: process.env.JWT_SECRET,
    keyMode: "legacy-jwt",
    tlsMode: "disable"
  }
}))')

{
  auth_header
  printf 'header = "Content-Type: application/json"\n'
  printf 'header = "Version: 2"\n'
  printf 'data = "%s"\n' "$(cfg_escape "$attach_body")"
} | curl -sS -o "$TMP_DIR/attach.json" -w '%{http_code}' -K - -X POST \
  "$FLEET_API_BASE/api/platform/projects" > "$TMP_DIR/attach.status"
attach_status=$(cat "$TMP_DIR/attach.status")
if [ "$attach_status" != "201" ]; then
  jq '{
    http_status: $status,
    code: (.code // .error.code),
    message: (.message // (if (.error | type) == "string" then .error else .error.message end)),
    preflight: (.preflight // .error.preflight),
    response_keys: keys,
    error_type: (.error | type),
    error_keys: (if (.error | type) == "object" then (.error | keys) else [] end)
  }' --arg status "$attach_status" "$TMP_DIR/attach.json" >&2
  exit 1
fi
ATTACHED=1

# A modern Fleet image must return durable preflight evidence. This deliberately
# fails old images that only returned ACTIVE_HEALTHY after a database ping.
jq -e '
  .attachment_state == "active" and
  .preflight.outcome == "pass" and
  ([.preflight.checks[] | select(.required == true and .status != "pass")] | length == 0)
' "$TMP_DIR/attach.json" >/dev/null
required_checks=$(jq '[.preflight.checks[] | select(.required == true)] | length' \
  "$TMP_DIR/attach.json")
echo "attach=201 required-preflight-checks=$required_checks"

auth_header | curl -fsS -K - -H 'Version: 2' \
  "$FLEET_API_BASE/api/platform/projects?limit=1000" > "$TMP_DIR/projects.json"
jq -e --arg ref "$REF" \
  '(.projects? // .) | map(.ref) | index("default") != null and index($ref) != null' \
  "$TMP_DIR/projects.json" >/dev/null
echo "project-list=contains-default-and-$REF"

query_cluster() {
  local ref="$1"
  {
    auth_header
    printf 'header = "Content-Type: application/json"\n'
    printf 'data = "{\\"query\\":\\"select (pg_control_system()).system_identifier::text as system_identifier, current_database() as database_name\\"}"\n'
  } | curl -fsS -K - -X POST "$FLEET_API_BASE/api/platform/pg-meta/$ref/query"
}
query_cluster default > "$TMP_DIR/default-query.json"
query_cluster "$REF" > "$TMP_DIR/target-query.json"
default_id=$(jq -r '.[0].system_identifier // empty' "$TMP_DIR/default-query.json")
target_id=$(jq -r '.[0].system_identifier // empty' "$TMP_DIR/target-query.json")
[ -n "$default_id" ] && [ -n "$target_id" ] && [ "$default_id" != "$target_id" ]
echo 'data-plane-isolation=distinct-postgres-system-identifiers'

auth_header | curl -fsS -K - \
  "$FLEET_API_BASE/api/platform/projects/$REF/databases-statuses" > "$TMP_DIR/health.json"
jq -e '.[0].status == "ACTIVE_HEALTHY"' "$TMP_DIR/health.json" >/dev/null
echo 'health=ACTIVE_HEALTHY'

# Backup is visible in Fleet, but an unenrolled target must degrade to a
# correlated setup state instead of returning an opaque 404 or probing noise.
auth_header | curl -fsS -K - \
  "$FLEET_API_BASE/api/platform/database/$REF/backup-operator/status" \
  > "$TMP_DIR/backup-status.json"
jq -e '
  .management.state == "unconfigured" and
  .management.configured == false and
  (.management.correlationId | type == "string" and length > 0)
' "$TMP_DIR/backup-status.json" >/dev/null
echo 'backup-management=unconfigured-with-remediation-contract'

# Project metadata must remain a non-secret browser contract.
auth_header | curl -fsS -K - \
  "$FLEET_API_BASE/api/platform/projects/$REF" > "$TMP_DIR/project.json"
jq -e '
  has("connectionString") | not and
  (tostring | contains("db_pass_enc") | not) and
  (tostring | contains("service_key_enc") | not)
' "$TMP_DIR/project.json" >/dev/null
anonymous_status=$(curl -sS -o /dev/null -w '%{http_code}' \
  "$FLEET_API_BASE/api/platform/projects/$REF")
[ "$anonymous_status" = "401" ]
echo 'permissions=authenticated-and-secret-redacted'

auth_header | curl -fsS -K - -X DELETE \
  "$FLEET_API_BASE/api/platform/projects/$REF" > "$TMP_DIR/detach.json"
ATTACHED=0
if ! jq -e '
  .projectRef == $ref and
  (.detachedAt | type == "string" and length > 0) and
  (.targetCleanupPending | type == "boolean") and
  .infrastructureDeleted == false
' --arg ref "$REF" \
  "$TMP_DIR/detach.json" >/dev/null; then
  jq . "$TMP_DIR/detach.json" >&2
  exit 1
fi
docker inspect -f '{{.State.Running}}' "$TARGET_DB_CONTAINER" | grep -qx true
docker inspect -f '{{.State.Running}}' "$TARGET_KONG_CONTAINER" | grep -qx true
echo 'detach=non-destructive target-containers=running'
echo 'multi-instance-e2e=PASS'
