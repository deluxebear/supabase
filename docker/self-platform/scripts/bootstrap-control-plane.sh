#!/usr/bin/env bash
set -Eeuo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="${CONTROL_PLANE_ENV_FILE:-$root_dir/control-plane.env}"
compose=(docker compose --env-file "$env_file" -f "$root_dir/docker-compose.control-plane.yml")

[ -f "$env_file" ] || {
  echo "ERROR: control-plane environment is missing: $env_file" >&2
  exit 1
}
envval() { grep -E "^$1=" "$env_file" | head -1 | cut -d= -f2- | tr -d '\r'; }
cfg_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

public_url="$(envval FLEET_PUBLIC_URL)"; public_url="${public_url%/}"
admin_email="$(envval PLATFORM_ADMIN_EMAIL)"
admin_password="$(envval PLATFORM_ADMIN_PASSWORD)"
jwt_secret="$(envval PLATFORM_JWT_SECRET)"
for value in public_url admin_email admin_password jwt_secret; do
  [ -n "${!value}" ] || { echo "ERROR: $value is empty in $env_file" >&2; exit 1; }
done

docker network inspect "$(envval FLEET_MANAGEMENT_NETWORK_NAME)" >/dev/null 2>&1 || \
  docker network create "$(envval FLEET_MANAGEMENT_NETWORK_NAME)" >/dev/null
"${compose[@]}" up -d --remove-orphans

ready=0
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "$public_url/api/get-utc-time"; then
    ready=1
    break
  fi
  sleep 2
done
[ "$ready" -eq 1 ] || {
  echo "ERROR: Central Studio did not become ready at $public_url" >&2
  exit 1
}

now="$(date +%s)"; exp="$((now + 60))"
header="$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)"
payload="$(printf '{"role":"service_role","iat":%d,"exp":%d}' "$now" "$exp" | b64url)"
signature="$(printf '%s.%s' "$header" "$payload" | openssl dgst -binary -sha256 -hmac "$jwt_secret" | b64url)"
service_jwt="$header.$payload.$signature"
gotrue="$public_url/platform-auth/v1"

admin_body="$(ADMIN_EMAIL="$admin_email" ADMIN_PASSWORD="$admin_password" node -e \
  'process.stdout.write(JSON.stringify({email:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD,email_confirm:true}))')"
{
  printf 'header = "Authorization: Bearer %s"\n' "$(cfg_escape "$service_jwt")"
  printf 'header = "Content-Type: application/json"\n'
  printf 'data = "%s"\n' "$(cfg_escape "$admin_body")"
} | curl -sS --retry 5 --retry-all-errors -K - -X POST -o /dev/null "$gotrue/admin/users"

login_body="$(ADMIN_EMAIL="$admin_email" ADMIN_PASSWORD="$admin_password" node -e \
  'process.stdout.write(JSON.stringify({email:process.env.ADMIN_EMAIL,password:process.env.ADMIN_PASSWORD}))')"
token_json="$({
  printf 'header = "Content-Type: application/json"\n'
  printf 'data = "%s"\n' "$(cfg_escape "$login_body")"
} | curl -fsS --retry 5 --retry-all-errors -K - -X POST "$gotrue/token?grant_type=password")"
token="$(printf '%s' "$token_json" | node -e \
  'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).access_token||""))')"
[ -n "$token" ] || { echo "ERROR: Central Studio administrator login failed" >&2; exit 1; }

printf 'header = "Authorization: Bearer %s"\n' "$(cfg_escape "$token")" | \
  curl -fsS --retry 5 --retry-all-errors -K - -X POST -o /dev/null "$public_url/api/platform/profile"

printf '%s\n' \
  "insert into platform.member_roles (profile_id, role_id)" \
  "select profile.id, 1 from platform.profiles profile" \
  "where profile.primary_email = :'admin_email'" \
  "on conflict do nothing;" | \
  "${compose[@]}" exec -T platform-db psql -U postgres -d platform \
    -v ON_ERROR_STOP=1 -v admin_email="$admin_email"

echo "Central Studio administrator is ready at $public_url"
echo "Use this exact origin in the browser; alternate localhost or IP origins are not supported."
