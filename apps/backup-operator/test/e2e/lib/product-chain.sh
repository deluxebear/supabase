#!/usr/bin/env bash

# Shared helpers for destructive E2E scenarios. Callers must define
# operator_url, assertion_key, project_id, and target_id.

base64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

service_assertion() {
  local aal="${1:-aal1}" now header payload signing signature
  now="$(date +%s)"
  header="$(printf '%s' '{"alg":"HS256","typ":"JWT"}' | base64url)"
  payload="$(jq -cn --arg project "$project_id" --arg target "$target_id" --arg aal "$aal" --argjson now "$now" \
    '{iss:"supabase-studio",aud:"backup-operator",sub:"e2e-owner",iat:$now,nbf:($now-1),exp:($now+60),scopes:["*"],projects:[$project,$target],aal:$aal,aal_authenticated_at:(if $aal=="aal2" then $now else null end)}' | base64url)"
  signing="$header.$payload"
  signature="$(printf '%s' "$signing" | openssl dgst -sha256 -mac HMAC -macopt "key:$assertion_key" -binary | base64url)"
  printf '%s.%s\n' "$signing" "$signature"
}

operator_request() {
  local method="$1" path="$2" body="${3:-}" aal="${4:-aal1}" token idempotency=() data=() response status
  token="$(service_assertion "$aal")"
  if [ "$method" != GET ]; then
    idempotency=(-H "Idempotency-Key: $(printf '%s\n%s\n%s' "$method" "$path" "$body" | openssl dgst -sha256 | awk '{print $NF}')")
  fi
  if [ -n "$body" ]; then data=(--data "$body"); fi
  response="$(curl -sS -X "$method" "$operator_url$path" \
    -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
    "${idempotency[@]}" "${data[@]}" -w $'\n%{http_code}')"
  status="${response##*$'\n'}"
  response="${response%$'\n'*}"
  if [ "$status" -lt 200 ] || [ "$status" -ge 300 ]; then
    printf 'operator %s %s returned HTTP %s: %s\n' "$method" "$path" "$status" "$response" >&2
    return 1
  fi
  printf '%s\n' "$response"
}

wait_operator_ready() {
  for _ in $(seq 1 120); do
    curl -fsS "$operator_url/readyz" >/dev/null 2>&1 && return 0
    if ! kill -0 "$operator_pid" 2>/dev/null; then
      cat "$operator_log" >&2
      return 1
    fi
    sleep 1
  done
  cat "$operator_log" >&2
  return 1
}

execute_restore_through_product() {
  local recovery_target="$1" plan hash response
  plan="$(operator_request POST "/v1/clusters/$target_id/restore-plans" "$(jq -cn --arg value "$recovery_target" '{recoveryTarget:$value}')")"
  hash="$(jq -er .hash <<<"$plan")"
  plan_hash="$hash"
  plan_id="$(jq -er .id <<<"$plan")"
  operator_request POST "/v1/clusters/$target_id/restore-plans/$plan_id/confirm" \
    "$(jq -cn --arg value "$hash" '{planHash:$value}')" aal2 >/dev/null
  response="$(operator_request POST "/v1/clusters/$target_id/restore-plans/$plan_id/execute" \
    "$(jq -cn --arg value "$hash" '{planHash:$value}')" aal2)"
  job_id="$(jq -er .id <<<"$response")"
  for _ in $(seq 1 480); do
    response="$(operator_request GET "/v1/clusters/$target_id/jobs/$job_id")"
    case "$(jq -r .state <<<"$response")" in
      succeeded) return 0 ;;
      failed|cancelled|manual-intervention)
        printf 'restore job terminal failure: %s\n' "$response" >&2
        cat "$operator_log" >&2
        return 1
        ;;
    esac
    sleep 1
  done
  printf 'restore job %s did not complete\n' "$job_id" >&2
  cat "$operator_log" >&2
  return 1
}

rollback_restore_through_product() {
  local response rollback_job
  response="$(operator_request POST "/v1/clusters/$target_id/jobs/$job_id/rollback" \
    "$(jq -cn --arg value "$plan_hash" '{planHash:$value}')" aal2)"
  rollback_job="$(jq -er .id <<<"$response")"
  for _ in $(seq 1 480); do
    response="$(operator_request GET "/v1/clusters/$target_id/jobs/$rollback_job")"
    case "$(jq -r .state <<<"$response")" in
      succeeded) return 0 ;;
      failed|cancelled|manual-intervention)
        printf 'rollback job terminal failure: %s\n' "$response" >&2
        cat "$operator_log" >&2
        return 1
        ;;
    esac
    sleep 1
  done
  printf 'rollback job %s did not complete\n' "$rollback_job" >&2
  return 1
}
