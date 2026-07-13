#!/usr/bin/env bash
set -euo pipefail

port="${BACKUP_OPERATOR_INTEGRATION_PORT:-18081}"
base_url="http://127.0.0.1:${port}"
work_dir="$(mktemp -d)"
operator_pid=""
assertion_key="01234567890123456789012345678901"
assertion_issuer="supabase-studio"
assertion_audience="backup-operator"

base64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
header="$(printf '%s' '{"alg":"HS256","typ":"JWT"}' | base64url)"
now="$(date +%s)"
payload="$(printf '{"iss":"%s","sub":"studio-integration","aud":"%s","exp":%s,"nbf":%s,"scopes":["*"],"projects":["*"]}' "$assertion_issuer" "$assertion_audience" "$((now + 120))" "$((now - 1))" | base64url)"
signature="$(printf '%s' "${header}.${payload}" | openssl dgst -sha256 -mac HMAC -macopt "key:${assertion_key}" -binary | base64url)"
assertion="${header}.${payload}.${signature}"

cleanup() {
  if [[ -n "$operator_pid" ]]; then
    kill "$operator_pid" 2>/dev/null || true
    wait "$operator_pid" 2>/dev/null || true
  fi
  rm -rf "$work_dir"
}
trap cleanup EXIT

go build -o "$work_dir/backup-operator" ./cmd/backup-operator
"$work_dir/backup-operator" \
  --mode=operator \
  --listen="127.0.0.1:${port}" \
  --service-assertion-key="$assertion_key" \
  --service-assertion-issuer="$assertion_issuer" \
  --service-assertion-audience="$assertion_audience" \
  --control-store-dsn="$work_dir/control.db" >"$work_dir/operator.log" 2>&1 &
operator_pid="$!"

for _ in $(seq 1 100); do
  if curl --fail --silent "$base_url/healthz" >/dev/null; then
    break
  fi
  sleep 0.1
done
curl --fail --silent "$base_url/healthz" >/dev/null

operation='{"id":"studio-integration-job","projectId":"project-a","targetId":"cluster-a","type":"backup","idempotencyKey":"studio-integration","planHash":"plan-hash","stepName":"execute","capability":"inspect","targetNodeId":"node-a","payload":{}}'
no_auth_status="$(curl --silent --output "$work_dir/no-auth.json" --write-out '%{http_code}' \
  --header 'Content-Type: application/json' --data "$operation" "$base_url/v1/operations")"
bogus_auth_status="$(curl --silent --output "$work_dir/bogus-auth.json" --write-out '%{http_code}' \
  --header 'Authorization: Bearer invalid-service-assertion' "$base_url/v1/operations/studio-integration-job")"

auth=(-H "Authorization: Bearer ${assertion}")
register_status="$(curl --silent --output "$work_dir/register.json" --write-out '%{http_code}' "${auth[@]}" \
  --header 'Content-Type: application/json' --header 'Idempotency-Key: studio-register-cluster-a' \
  --data '{"projectId":"project-a","targetId":"cluster-a","systemIdentifier":"postgres-a","dataDomain":"pgdata-a"}' \
  "$base_url/v1/clusters")"
create_status="$(curl --silent --output "$work_dir/create.json" --write-out '%{http_code}' "${auth[@]}" \
  --header 'Content-Type: application/json' --header 'Idempotency-Key: studio-integration' \
  --data "$operation" "$base_url/v1/operations")"
if [[ "$register_status" != "201" || "$create_status" != "201" ]]; then
  printf 'cluster registration HTTP %s: ' "$register_status" >&2
  cat "$work_dir/register.json" >&2
  printf '\noperation creation HTTP %s: ' "$create_status" >&2
  cat "$work_dir/create.json" >&2
  printf '\n' >&2
  exit 2
fi

curl --fail --silent "${auth[@]}" "$base_url/v1/operations/studio-integration-job/events?cursor=0&limit=1" >"$work_dir/events-1.txt"
cursor="$(awk '/^id:/{print $2; exit}' "$work_dir/events-1.txt")"
test "$cursor" = "1"
curl --fail --silent "${auth[@]}" --header 'Idempotency-Key: studio-cancel-operation' \
  --request POST "$base_url/v1/operations/studio-integration-job/cancel" >/dev/null
curl --fail --silent "${auth[@]}" --header "Last-Event-ID: ${cursor}" \
  "$base_url/v1/operations/studio-integration-job/events?limit=100" >"$work_dir/events-2.txt"
grep --quiet '^id: 2$' "$work_dir/events-2.txt"
grep --quiet '^event: job_cancelled$' "$work_dir/events-2.txt"

policy_status="$(curl --silent --output "$work_dir/policy.json" --write-out '%{http_code}' "${auth[@]}" \
  --header 'Content-Type: application/json' --header 'Idempotency-Key: studio-update-policy' \
  --request PUT --data '{"enabled":false,"fullSchedule":"0 0 * * *","backupFrom":"primary"}' "$base_url/v1/clusters/cluster-a/backup-policy")"
job_status="$(curl --silent --output "$work_dir/job.json" --write-out '%{http_code}' \
  "${auth[@]}" "$base_url/v1/clusters/cluster-a/jobs/studio-integration-job")"
restore_status="$(curl --silent --output "$work_dir/restore.json" --write-out '%{http_code}' \
  "${auth[@]}" --header 'Content-Type: application/json' --header 'Idempotency-Key: studio-create-restore-plan' \
  --data '{"recoveryTarget":"2026-07-13T09:30:00Z"}' "$base_url/v1/clusters/cluster-a/restore-plans")"

cat <<JSON
{
  "realOperator": true,
  "operationCreateWithoutAssertionStatus": ${no_auth_status},
  "operationCreateWithValidAssertionStatus": ${create_status},
  "operationReadWithInvalidAssertionStatus": ${bogus_auth_status},
  "clusterRegistrationStatus": ${register_status},
  "sseInitialCursor": ${cursor},
  "sseReconnectEvent": "job_cancelled",
  "studioPolicyPathStatus": ${policy_status},
  "studioJobPathStatus": ${job_status},
  "studioRestorePlanPathStatus": ${restore_status}
}
JSON

gaps=0
if [[ "$no_auth_status" != "401" || "$bogus_auth_status" != "401" || "$register_status" != "201" || "$create_status" != "201" ]]; then
  echo "GAP: the real Operator does not enforce service assertions on its HTTP API" >&2
  gaps=$((gaps + 1))
fi
if [[ "$policy_status" == "404" || "$job_status" == "404" || "$restore_status" == "404" ]]; then
  echo "GAP: the real Operator does not expose the cluster-scoped routes used by Studio" >&2
  gaps=$((gaps + 1))
fi

if [[ "$gaps" -gt 0 && "${ALLOW_KNOWN_GAPS:-0}" != "1" ]]; then
  exit 2
fi
