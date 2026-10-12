#!/usr/bin/env bash
# End-to-end check of backups on a Fleet-managed Compose stack that already ran
# fleet-managed/scripts/enable-backups.sh. Run it from the repository's `docker`
# directory on the control-plane host, with the stack's Compose arguments:
#
#   self-platform/scripts/verify-compose-backups.sh project-a -- \
#     -p supabase-managed-a --env-file self-platform/.env \
#     --env-file fleet-managed/project-a.env -f docker-compose.yml ...
#
# It takes a full backup, writes rows before and after a target time, runs an
# isolated restore drill, restores the stack to the target time, checks the
# rows and services, rolls back, and checks the rows again. It also checks that
# the backup Docker proxy refuses other containers and that drill credentials
# cannot write to the repository. The stack is unavailable during the restore
# and the rollback. The fixture table is dropped at the end.
set -Eeuo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
control_env="${FLEET_CONTROL_ENV:-$root_dir/self-platform/control-plane.env}"
operator_url="${BACKUP_OPERATOR_URL:-http://127.0.0.1:8080}"
repository_ca="${BACKUP_REPOSITORY_CA:-$root_dir/self-platform/secrets/fleet-management/ca.crt}"
rc_image="${BACKUP_REPOSITORY_CLIENT_IMAGE:-rustfs/rc:v0.1.36}"
management_network="${FLEET_MANAGEMENT_NETWORK_NAME:-fleet-management}"

usage() { echo "usage: $0 <project-ref> -- <docker compose arguments>" >&2; exit 2; }
fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }
step() { printf '\n==> %s\n' "$*"; }

ref="${1:-}"
[ "${2:-}" = "--" ] || usage
shift 2
[ "$#" -gt 0 ] || usage
[[ "$ref" =~ ^[a-z0-9][a-z0-9-]{0,49}$ ]] || fail "invalid project ref"
compose_args=("$@" -f "$root_dir/fleet-managed/docker-compose.backup.yml")
compose() { docker compose "${compose_args[@]}" "$@"; }
envval() { grep -E "^$2=" "$1" | head -1 | cut -d= -f2- | tr -d '\r'; }
key="$(envval "$control_env" FLEET_CONTROL_SERVICE_ASSERTION_KEY)"
[ "${#key}" -ge 32 ] || fail "FLEET_CONTROL_SERVICE_ASSERTION_KEY is missing from $control_env"
command -v jq >/dev/null || fail "jq is required"

b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
assertion() {
  local now header payload signature
  now="$(date +%s)"
  header="$(printf '%s' '{"alg":"HS256","typ":"JWT"}' | b64url)"
  payload="$(jq -nc --argjson now "$now" '{iss:"studio-platform",sub:"verify-compose-backups",aud:"backup-operator",exp:($now+120),nbf:($now-5),scopes:["*"],projects:["*"],aal:"aal2",aal_authenticated_at:$now}' | b64url)"
  signature="$(printf '%s' "$header.$payload" | openssl dgst -sha256 -hmac "$key" -binary | b64url)"
  printf '%s' "$header.$payload.$signature"
}
api() {
  local method="$1" path="$2" body="${3:-}"
  local args=(-sS -X "$method" -H "Authorization: Bearer $(assertion)" -H 'Content-Type: application/json')
  [ "$method" = GET ] || args+=(-H "Idempotency-Key: verify-$(openssl rand -hex 8)")
  [ -z "$body" ] || args+=(--data "$body")
  curl --fail-with-body "${args[@]}" "$operator_url$path"
}
wait_job() {
  local id="$1" state=""
  for _ in $(seq 1 300); do
    state="$(api GET "/v1/clusters/$ref/jobs/$id" | jq -r .state)"
    case "$state" in succeeded) return 0 ;; failed | orphaned | cancelled | manual-intervention) fail "job $id ended $state" ;; esac
    sleep 2
  done
  fail "job $id did not finish (last state $state)"
}
psql_db() { compose exec -T db psql -U supabase_admin -h /var/run/postgresql -d postgres -v ON_ERROR_STOP=1 -Atc "$1"; }
rows() { psql_db "select coalesce(string_agg(note, ',' order by id), '') from public.backup_e2e"; }
services_up() {
  local service
  for service in kong auth rest storage; do
    [ "$(docker inspect -f '{{.State.Running}}' "$(compose ps -q "$service")" 2>/dev/null)" = true ] || return 1
  done
}

step "Checking the cluster"
cluster="$(api GET "/v1/clusters/$ref")"
[ "$(jq -r '.discovery.blockers | length' <<<"$cluster")" = 0 ] || fail "discovery has blockers: $cluster"
[ "$(api GET "/v1/clusters/$ref/pitr" | jq -r '.enabled and .healthy')" = true ] || fail "PITR is not enabled and healthy"
pass "discovery and PITR come from the Agent"

step "Taking a full backup"
backup="$(api POST "/v1/clusters/$ref/backups" '{"type":"full"}')"
wait_job "$(jq -r .id <<<"$backup")"
backup_done="$(date +%s)"
pass "full backup"

step "Writing fixture rows around a target time"
psql_db "drop table if exists public.backup_e2e; create table public.backup_e2e(id serial primary key, note text not null)" >/dev/null
psql_db "insert into public.backup_e2e(note) values('before-target'); select pg_switch_wal()" >/dev/null
sleep 2
target="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
sleep 2
psql_db "insert into public.backup_e2e(note) values('after-target'); select pg_switch_wal()" >/dev/null
echo "target: $target"

step "Running an isolated restore drill"
# The drill targets five minutes ago, which must follow the new backup.
wait_until=$((backup_done + 330))
while [ "$(date +%s)" -lt "$wait_until" ]; do sleep 5; done
drill_job="$(api POST "/v1/clusters/$ref/maintenance" '{"kind":"restore-drill"}' | jq -r .id)"
wait_job "$drill_job"
[ "$(api GET "/v1/clusters/$ref/backups" | jq -r .confidence)" = drill-verified ] || fail "recovery confidence is not drill-verified"
pass "drill passed; confidence is drill-verified"

step "Restoring to the target time"
plan="$(api POST "/v1/clusters/$ref/restore-plans" "$(jq -nc --arg t "$target" '{recoveryTarget:$t}')")"
plan_id="$(jq -r .id <<<"$plan")" plan_hash="$(jq -r .hash <<<"$plan")"
api POST "/v1/clusters/$ref/restore-plans/$plan_id/confirm" "$(jq -nc --arg h "$plan_hash" '{planHash:$h}')" >/dev/null
restore_job="$(api POST "/v1/clusters/$ref/restore-plans/$plan_id/execute" "$(jq -nc --arg h "$plan_hash" '{planHash:$h}')" | jq -r .id)"
wait_job "$restore_job"
[ "$(rows)" = before-target ] || fail "rows after restore: $(rows)"
pass "restore kept only the row written before the target"
for _ in $(seq 1 30); do services_up && break; sleep 2; done
services_up || fail "services did not start after the restore"
pass "services run again after cut-over"

step "Rolling back"
api POST "/v1/clusters/$ref/jobs/$restore_job/rollback" "$(jq -nc --arg h "$plan_hash" '{planHash:$h}')" >/dev/null
wait_job "$restore_job-rollback"
[ "$(rows)" = before-target,after-target ] || fail "rows after rollback: $(rows)"
for _ in $(seq 1 30); do services_up && break; sleep 2; done
services_up || fail "services did not start after the rollback"
pass "rollback restored both rows and the services"

step "Checking isolation"
agent="$(compose ps -q backup-agent)"
project="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$agent")"
other="$(docker ps --format '{{.ID}} {{.Label "com.docker.compose.project"}}' | awk -v p="$project" '$2 != p {print $1; exit}')"
[ -n "$other" ] || fail "no container of another project to test the proxy with"
status="$(docker exec "$agent" curl -s -o /dev/null -w '%{http_code}' -X POST "http://fleet-docker-proxy-backup:2375/containers/$other/stop")"
[ "$status" = 403 ] || fail "the backup proxy answered $status for another project's container"
status="$(docker exec "$agent" curl -s -o /dev/null -w '%{http_code}' -X POST "http://fleet-docker-proxy-backup:2375/containers/$(compose ps -q imgproxy)/stop")"
[ "$status" = 403 ] || fail "the backup proxy answered $status for a service outside the fence"
pass "the backup proxy refuses containers outside its allowlist"
drill_secret="$(envval "$root_dir/fleet-managed/state/$ref/backup/drill.conf" repo1-s3-key-secret)"
if docker run --rm --network "$management_network" -e SECRET="$drill_secret" -e REF="$ref" \
  -v "$repository_ca:/ca.crt:ro" -e SSL_CERT_FILE=/ca.crt --entrypoint /bin/sh "$rc_image" -c \
  'rc alias set ro https://backup-repository:9000 "backup-$REF-ro" "$SECRET" >/dev/null && echo x >/tmp/x && rc cp /tmp/x "ro/fleet-backup-$REF/verify-write-probe"' >/dev/null 2>&1; then
  fail "drill credentials could write to the repository"
fi
pass "drill credentials cannot write to the repository"

step "Cleaning up"
psql_db "drop table public.backup_e2e" >/dev/null
echo
echo "All checks passed for $ref."
