#!/usr/bin/env bash
# End-to-end acceptance for the Fleet staged Attach Wizard contract.
#
# The target stack must already be running. This script never prints project
# credentials or enrollment tokens, and a staged rollback only removes control
# plane bindings: it does not stop or delete target containers or volumes.
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCKER_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
FLEET_ENV_FILE="${FLEET_ENV_FILE:-$DOCKER_DIR/self-platform/control-plane.env}"
TARGET_ENV_FILE="${TARGET_ENV_FILE:-$DOCKER_DIR/fleet-managed/project-b.env}"
FLEET_API_BASE="${FLEET_API_BASE:-http://192.168.50.149:8001}"
TARGET_PUBLIC_HOST="${TARGET_PUBLIC_HOST:-192.168.50.149}"
TARGET_PROJECT_REF="${TARGET_PROJECT_REF:-project-b}"
TARGET_PROJECT_NAME="${TARGET_PROJECT_NAME:-Managed Project B}"
TARGET_COMPOSE_PROJECT="${TARGET_COMPOSE_PROJECT:-supabase-managed-b}"
BASELINE_PROJECT_REF="${BASELINE_PROJECT_REF:-project-a}"

for command in curl docker jq node sed; do
  command -v "$command" >/dev/null || {
    echo "ERROR: required command '$command' is unavailable" >&2
    exit 1
  }
done
for file in "$FLEET_ENV_FILE" "$TARGET_ENV_FILE"; do
  [ -f "$file" ] || { echo "ERROR: missing environment file: $file" >&2; exit 1; }
done

envval() {
  local file="$1" name="$2"
  sed -n "s/^${name}=//p" "$file" | head -1 | tr -d '\r'
}
require_value() {
  local name="$1" value="$2"
  [ -n "$value" ] || { echo "ERROR: required setting '$name' is empty" >&2; exit 1; }
}
cfg_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

PLATFORM_ADMIN_EMAIL="$(envval "$FLEET_ENV_FILE" PLATFORM_ADMIN_EMAIL)"
PLATFORM_ADMIN_PASSWORD="$(envval "$FLEET_ENV_FILE" PLATFORM_ADMIN_PASSWORD)"
TARGET_DB_PASSWORD="$(envval "$TARGET_ENV_FILE" POSTGRES_PASSWORD)"
TARGET_ANON_KEY="$(envval "$TARGET_ENV_FILE" ANON_KEY)"
TARGET_SERVICE_ROLE_KEY="$(envval "$TARGET_ENV_FILE" SERVICE_ROLE_KEY)"
TARGET_JWT_SECRET="$(envval "$TARGET_ENV_FILE" JWT_SECRET)"
TARGET_DB_DIRECT_PORT="$(envval "$TARGET_ENV_FILE" MANAGED_DB_DIRECT_HOST_PORT)"
TARGET_DB_SESSION_PORT="$(envval "$TARGET_ENV_FILE" MANAGED_POSTGRES_HOST_PORT)"
TARGET_DB_TRANSACTION_PORT="$(envval "$TARGET_ENV_FILE" MANAGED_POOLER_HOST_PORT)"
TARGET_KONG_HTTP_PORT="$(envval "$TARGET_ENV_FILE" MANAGED_KONG_HTTP_PORT)"
TARGET_CONTAINER_PREFIX="$(envval "$TARGET_ENV_FILE" MANAGED_CONTAINER_PREFIX)"
for variable in PLATFORM_ADMIN_EMAIL PLATFORM_ADMIN_PASSWORD TARGET_DB_PASSWORD \
  TARGET_ANON_KEY TARGET_SERVICE_ROLE_KEY TARGET_JWT_SECRET TARGET_DB_DIRECT_PORT \
  TARGET_DB_SESSION_PORT TARGET_DB_TRANSACTION_PORT TARGET_KONG_HTTP_PORT \
  TARGET_CONTAINER_PREFIX; do
  require_value "$variable" "${!variable}"
done

TMP_DIR="$(mktemp -d)"
CONTROL_RECORD_PRESENT=0
ACTIVATED=0
cleanup() {
  if [ "$CONTROL_RECORD_PRESENT" -eq 1 ] && [ "$ACTIVATED" -eq 0 ] && [ -n "${TOKEN:-}" ]; then
    request_json POST "/api/platform/projects/$TARGET_PROJECT_REF/attachment/rollback" '{}' \
      "$TMP_DIR/cleanup-rollback.json" >/dev/null || true
  fi
  find "$TMP_DIR" -type f -delete
  rmdir "$TMP_DIR"
}
trap cleanup EXIT

auth_header() { printf 'header = "Authorization: Bearer %s"\n' "$(cfg_escape "$TOKEN")"; }
request_json() {
  local method="$1" path="$2" body="$3" output="$4"
  {
    auth_header
    if [ -n "$body" ]; then
      printf 'header = "Content-Type: application/json"\n'
      printf 'data = "%s"\n' "$(cfg_escape "$body")"
    fi
  } | curl -sS -o "$output" -w '%{http_code}' -K - -X "$method" "$FLEET_API_BASE$path"
}

login_body="$(PLATFORM_ADMIN_EMAIL="$PLATFORM_ADMIN_EMAIL" \
  PLATFORM_ADMIN_PASSWORD="$PLATFORM_ADMIN_PASSWORD" node -e \
  'process.stdout.write(JSON.stringify({email:process.env.PLATFORM_ADMIN_EMAIL,password:process.env.PLATFORM_ADMIN_PASSWORD}))')"
{
  printf 'header = "Content-Type: application/json"\n'
  printf 'data = "%s"\n' "$(cfg_escape "$login_body")"
} | curl -fsS -K - -X POST \
  "$FLEET_API_BASE/platform-auth/v1/token?grant_type=password" > "$TMP_DIR/login.json"
TOKEN="$(jq -r '.access_token // empty' "$TMP_DIR/login.json")"
require_value TOKEN "$TOKEN"

export TARGET_PROJECT_REF TARGET_PROJECT_NAME TARGET_PUBLIC_HOST TARGET_DB_PASSWORD \
  TARGET_ANON_KEY TARGET_SERVICE_ROLE_KEY TARGET_JWT_SECRET TARGET_DB_DIRECT_PORT \
  TARGET_DB_SESSION_PORT TARGET_DB_TRANSACTION_PORT TARGET_KONG_HTTP_PORT
attach_body="$(node - <<'NODE'
const ref = process.env.TARGET_PROJECT_REF
const apiUrl = `http://${process.env.TARGET_PUBLIC_HOST}:${process.env.TARGET_KONG_HTTP_PORT}`
process.stdout.write(JSON.stringify({
  mode: 'external',
  attachment_mode: 'staged',
  organization_slug: 'default',
  name: process.env.TARGET_PROJECT_NAME,
  ref,
  connection: {
    dbHost: `db-${ref}`,
    dbPort: 5432,
    dbName: 'postgres',
    dbUser: 'postgres',
    dbUserReadonly: 'supabase_read_only_user',
    dbPass: process.env.TARGET_DB_PASSWORD,
    dbPassReadonly: process.env.TARGET_DB_PASSWORD,
    kongUrl: `http://kong-${ref}:8000`,
    restUrl: `http://kong-${ref}:8000/rest/v1/`,
    anonKey: process.env.TARGET_ANON_KEY,
    serviceKey: process.env.TARGET_SERVICE_ROLE_KEY,
    jwtSecret: process.env.TARGET_JWT_SECRET,
    keyMode: 'legacy-jwt',
    tlsMode: 'disable'
  },
  public_endpoints: {
    apiUrl,
    restUrl: `${apiUrl}/rest/v1`,
    authUrl: `${apiUrl}/auth/v1`,
    storageUrl: `${apiUrl}/storage/v1`,
    realtimeUrl: `${apiUrl}/realtime/v1`,
    functionsUrl: `${apiUrl}/functions/v1`,
    s3Url: `${apiUrl}/storage/v1/s3`,
    directPostgres: {
      host: process.env.TARGET_PUBLIC_HOST,
      port: Number(process.env.TARGET_DB_DIRECT_PORT),
      database: 'postgres', user: 'postgres', tlsMode: 'disable'
    },
    supavisor: {
      host: process.env.TARGET_PUBLIC_HOST,
      transactionPort: Number(process.env.TARGET_DB_TRANSACTION_PORT),
      sessionPort: Number(process.env.TARGET_DB_SESSION_PORT),
      database: 'postgres', user: 'postgres', tenantId: ref, tlsMode: 'disable'
    }
  }
}))
NODE
)"

# A deliberately unreachable internal identity must fail before persistence.
failed_ref="${TARGET_PROJECT_REF}-fail"
failed_body="$(ATTACH_BODY="$attach_body" FAILED_REF="$failed_ref" node -e '
const body = JSON.parse(process.env.ATTACH_BODY)
body.ref = process.env.FAILED_REF
body.name += " Failure Probe"
body.connection.dbHost = "db-intentionally-missing"
body.connection.kongUrl = "http://kong-intentionally-missing:8000"
body.connection.restUrl = "http://kong-intentionally-missing:8000/rest/v1/"
process.stdout.write(JSON.stringify(body))')"
failed_status="$(request_json POST /api/platform/projects "$failed_body" "$TMP_DIR/failed.json")"
[ "$failed_status" = 422 ] || {
  echo "ERROR: expected failed preflight HTTP 422, got $failed_status" >&2
  jq '{code,message,preflight}' "$TMP_DIR/failed.json" >&2
  exit 1
}
auth_header | curl -fsS -K - -H 'Version: 2' \
  "$FLEET_API_BASE/api/platform/projects?limit=1000" > "$TMP_DIR/projects-after-failure.json"
jq -e --arg ref "$failed_ref" '(.projects // .) | map(.ref) | index($ref) == null' \
  "$TMP_DIR/projects-after-failure.json" >/dev/null
echo 'failed-preflight=no-project-persisted'

stage_project() {
  local output="$1"
  local status
  status="$(request_json POST /api/platform/projects "$attach_body" "$output")"
  [ "$status" = 201 ] || {
    echo "ERROR: staged attach returned HTTP $status" >&2
    jq '{code,message,preflight}' "$output" >&2
    exit 1
  }
  jq -e '
    .attachment_state == "validating" and .status == "COMING_UP" and
    .preflight.outcome == "pass" and
    ([.preflight.checks[] | select(.required == true and .status != "pass")] | length == 0)
  ' "$output" >/dev/null
  CONTROL_RECORD_PRESENT=1
}

stage_project "$TMP_DIR/stage-rollback.json"
rollback_status="$(request_json POST "/api/platform/projects/$TARGET_PROJECT_REF/attachment/rollback" '{}' "$TMP_DIR/rollback.json")"
[ "$rollback_status" = 200 ]
jq -e --arg ref "$TARGET_PROJECT_REF" '
  .projectRef == $ref and .infrastructureDeleted == false and
  (.rolledBackAt | type == "string" and length > 0)
' "$TMP_DIR/rollback.json" >/dev/null
CONTROL_RECORD_PRESENT=0
docker inspect -f '{{.State.Running}}' "$TARGET_CONTAINER_PREFIX-db" | grep -qx true
docker inspect -f '{{.State.Running}}' "$TARGET_CONTAINER_PREFIX-kong" | grep -qx true
echo 'staged-rollback=non-destructive target-containers=running'

stage_project "$TMP_DIR/stage-final.json"
auth_header | curl -fsS -K - \
  "$FLEET_API_BASE/api/platform/organizations/default/management-targets" > "$TMP_DIR/targets.json"
TARGET_ID="$(jq -r '[.targets[] | select(.state == "active")][0].id // empty' "$TMP_DIR/targets.json")"
require_value TARGET_ID "$TARGET_ID"
# shellcheck disable=SC2016 # JavaScript template interpolation runs inside Node.
binding_body="$(TARGET_ID="$TARGET_ID" TARGET_PROJECT_REF="$TARGET_PROJECT_REF" node -e '
process.stdout.write(JSON.stringify({
  managementTargetId: process.env.TARGET_ID,
  executionTarget: `compose://${process.env.TARGET_PROJECT_REF}`,
  deploymentKind: "compose",
  allowedCapabilityPrefixes: ["backup.", "runtime.", "database.", "functions."]
}))')"
binding_status="$(request_json PUT "/api/platform/projects/$TARGET_PROJECT_REF/management-binding" \
  "$binding_body" "$TMP_DIR/binding.json")"
[ "$binding_status" = 201 ] || { jq '{code,message}' "$TMP_DIR/binding.json" >&2; exit 1; }
BINDING_ID="$(jq -r '.binding.id // empty' "$TMP_DIR/binding.json")"
ORGANIZATION_ID="$(jq -r '.binding.organizationId // empty' "$TMP_DIR/binding.json")"
require_value BINDING_ID "$BINDING_ID"
require_value ORGANIZATION_ID "$ORGANIZATION_ID"

token_status="$(request_json POST "/api/platform/projects/$TARGET_PROJECT_REF/management-binding/enrollment-token" \
  '{}' "$TMP_DIR/enrollment.json")"
[ "$token_status" = 201 ] || { jq '{code,message}' "$TMP_DIR/enrollment.json" >&2; exit 1; }
ENROLLMENT_TOKEN="$(jq -r '.token // empty' "$TMP_DIR/enrollment.json")"
issued_binding_id="$(jq -r '.bindingId // empty' "$TMP_DIR/enrollment.json")"
require_value ENROLLMENT_TOKEN "$ENROLLMENT_TOKEN"
[ "$issued_binding_id" = "$BINDING_ID" ]

compose=(docker compose -p "$TARGET_COMPOSE_PROJECT"
  --env-file "$DOCKER_DIR/self-platform/.env"
  --env-file "$TARGET_ENV_FILE"
  -f "$DOCKER_DIR/docker-compose.yml"
  -f "$DOCKER_DIR/fleet-managed/docker-compose.override.yml")

FLEET_AGENT_ENROLLMENT_TOKEN="$ENROLLMENT_TOKEN" \
FLEET_AGENT_ORGANIZATION_ID="$ORGANIZATION_ID" \
FLEET_AGENT_TARGET_ID="$TARGET_ID" \
FLEET_AGENT_BINDING_ID="$BINDING_ID" \
FLEET_AGENT_EXECUTION_TARGET="compose://$TARGET_PROJECT_REF" \
  "${compose[@]}" --profile enroll run --rm fleet-agent-bootstrap >/dev/null

FLEET_AGENT_ORGANIZATION_ID="$ORGANIZATION_ID" \
FLEET_AGENT_TARGET_ID="$TARGET_ID" \
FLEET_AGENT_BINDING_ID="$BINDING_ID" \
  "${compose[@]}" --profile agent up -d fleet-agent >/dev/null

agent_online=0
for _ in $(seq 1 40); do
  status="$(request_json GET "/api/platform/projects/$TARGET_PROJECT_REF/management-binding" '' \
    "$TMP_DIR/binding-status.json")"
  if [ "$status" = 200 ] && jq -e '
    .binding.state == "active" and .binding.agentSessionState == "online" and
    (.binding.agentId | type == "string" and length > 0)
  ' "$TMP_DIR/binding-status.json" >/dev/null; then
    agent_online=1
    break
  fi
  sleep 2
done
[ "$agent_online" -eq 1 ] || {
  echo 'ERROR: Agent did not reach an online identity-proof state' >&2
  jq '{binding: (.binding | {state,agentSessionState,agentId,lastSeenAt})}' \
    "$TMP_DIR/binding-status.json" >&2
  exit 1
}
echo 'agent=online identity-proof=verified'

activation_status="$(request_json POST "/api/platform/projects/$TARGET_PROJECT_REF/attachment/activate" \
  '{}' "$TMP_DIR/activation.json")"
[ "$activation_status" = 200 ]
jq -e '.attachmentState == "active"' "$TMP_DIR/activation.json" >/dev/null
ACTIVATED=1

query_cluster() {
  local ref="$1" output="$2"
  local query_body
  query_body='{"query":"select (pg_control_system()).system_identifier::text as system_identifier, current_database() as database_name"}'
  [ "$(request_json POST "/api/platform/pg-meta/$ref/query" "$query_body" "$output")" = 200 ]
}
query_cluster "$BASELINE_PROJECT_REF" "$TMP_DIR/baseline-query.json"
query_cluster "$TARGET_PROJECT_REF" "$TMP_DIR/target-query.json"
baseline_id="$(jq -r '.[0].system_identifier // empty' "$TMP_DIR/baseline-query.json")"
target_id="$(jq -r '.[0].system_identifier // empty' "$TMP_DIR/target-query.json")"
[ -n "$baseline_id" ] && [ -n "$target_id" ] && [ "$baseline_id" != "$target_id" ]

auth_header | curl -fsS -K - \
  "$FLEET_API_BASE/api/platform/projects/$TARGET_PROJECT_REF/capabilities" > "$TMP_DIR/capabilities.json"
jq -e '
  [.capabilities[] | select(.source == "agent" and .state == "available")] | length > 0
' "$TMP_DIR/capabilities.json" >/dev/null
auth_header | curl -fsS -K - -H 'Version: 2' \
  "$FLEET_API_BASE/api/platform/projects?limit=1000" > "$TMP_DIR/projects-final.json"
jq -e --arg a "$BASELINE_PROJECT_REF" --arg b "$TARGET_PROJECT_REF" '
  (.projects // .) | map(.ref) as $refs | ($refs | index($a) != null and index($b) != null)
' "$TMP_DIR/projects-final.json" >/dev/null

auth_header | curl -fsS -K - \
  "$FLEET_API_BASE/api/platform/projects/$TARGET_PROJECT_REF" > "$TMP_DIR/project.json"
jq -e '
  has("connectionString") | not and
  (tostring | contains("db_pass_enc") | not) and
  (tostring | contains("service_key_enc") | not)
' "$TMP_DIR/project.json" >/dev/null

echo 'activation=active two-projects=attached'
echo 'isolation=distinct-postgres-identities agent-capabilities=project-scoped'
echo 'staged-attachment-e2e=PASS'
