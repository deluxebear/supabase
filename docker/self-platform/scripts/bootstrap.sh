#!/usr/bin/env bash
# [self-platform] Idempotent bootstrap for the all-in-one stack. Safe to re-run.
#   Phase 1: ensure the _platform database exists (pre-existing PGDATA volumes;
#            fresh volumes already got it from docker-entrypoint-initdb.d).
#   Phase 2: ensure the first admin exists, has a profile, and holds Owner.
#   Phase 3: register/refresh the default project in platform.projects.
# Requires: docker, curl, openssl. No node/psql needed on the host.
set -Eeuo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "ERROR: missing .env (cp .env.example .env first)" >&2; exit 1; }
# .env values may contain unquoted spaces (upstream style) — never `source` it.
envval() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | tr -d '\r'; }

POSTGRES_PASSWORD="$(envval POSTGRES_PASSWORD)"
POSTGRES_PORT="$(envval POSTGRES_PORT)"
POSTGRES_DB="$(envval POSTGRES_DB)"
JWT_SECRET="$(envval JWT_SECRET)"
ANON_KEY="$(envval ANON_KEY)"
SERVICE_ROLE_KEY="$(envval SERVICE_ROLE_KEY)"
SUPABASE_PUBLIC_URL="$(envval SUPABASE_PUBLIC_URL)"; SUPABASE_PUBLIC_URL="${SUPABASE_PUBLIC_URL%/}"
API_EXTERNAL_URL="$(envval API_EXTERNAL_URL)"
SUPABASE_PUBLISHABLE_KEY="$(envval SUPABASE_PUBLISHABLE_KEY)"
SUPABASE_SECRET_KEY="$(envval SUPABASE_SECRET_KEY)"
PLATFORM_POSTGRES_PASSWORD="$(envval PLATFORM_POSTGRES_PASSWORD)"
PLATFORM_JWT_SECRET="$(envval PLATFORM_JWT_SECRET)"
PLATFORM_ENCRYPTION_KEY="$(envval PLATFORM_ENCRYPTION_KEY)"
export PLATFORM_ENCRYPTION_KEY
PLATFORM_ADMIN_EMAIL="$(envval PLATFORM_ADMIN_EMAIL)"
PLATFORM_ADMIN_PASSWORD="$(envval PLATFORM_ADMIN_PASSWORD)"
LOGFLARE_PRIVATE_ACCESS_TOKEN="$(envval LOGFLARE_PRIVATE_ACCESS_TOKEN)"
ENABLED_FEATURES_LOGS_ALL="$(envval ENABLED_FEATURES_LOGS_ALL)"
PROJECT_NAME="$(envval STUDIO_DEFAULT_PROJECT)"; PROJECT_NAME="${PROJECT_NAME:-Default Project}"

for v in POSTGRES_PASSWORD POSTGRES_PORT POSTGRES_DB SUPABASE_PUBLIC_URL \
         PLATFORM_POSTGRES_PASSWORD \
         PLATFORM_JWT_SECRET PLATFORM_ENCRYPTION_KEY PLATFORM_ADMIN_EMAIL \
         PLATFORM_ADMIN_PASSWORD SERVICE_ROLE_KEY ANON_KEY JWT_SECRET; do
  [ -n "$(eval "printf '%s' \"\$$v\"")" ] || { echo "ERROR: $v is empty in .env" >&2; exit 1; }
done

case "$POSTGRES_PORT" in
  ''|*[!0-9]*) echo "ERROR: POSTGRES_PORT ('$POSTGRES_PORT') is not numeric" >&2; exit 1 ;;
esac

# [self-platform] Container-reachable-origin invariant. Studio's server-side
# session verification dials NEXT_PUBLIC_GOTRUE_URL
# (${SUPABASE_PUBLIC_URL}/platform-auth/v1), and per-ref data-plane calls
# dial the registry's kong_url (${SUPABASE_PUBLIC_URL}) — both FROM INSIDE
# the studio container. A loopback SUPABASE_PUBLIC_URL makes both hairpin
# back to the container itself instead of reaching kong, and every
# authenticated dashboard API call then fails with 401. See README.md
# section 2 for the full explanation.
is_loopback_url() {
  local url host
  # Lowercase the URL for case-insensitive matching.
  url="$(printf '%s\n' "$1" | tr '[:upper:]' '[:lower:]')"
  # Strip scheme (scheme://).
  url="${url#*://}"
  # Strip userinfo (user[:pass]@host).
  url="${url##*@}"
  # Extract host: handle [ipv6]:port or host:port or host/path.
  # Check if URL starts with [ (IPv6 in brackets).
  if [ "${url#[}" != "$url" ]; then
    # IPv6 in brackets: extract content between [ and ].
    host="${url#[}"        # remove leading [
    host="${host%%]*}"     # remove trailing ] and everything after
  else
    # IPv4 or hostname: extract host by removing :port and /path.
    host="${url%%:*}"
    host="${host%%/*}"
  fi
  # Match against loopback addresses.
  case "$host" in
    localhost|127.*|::1|0.0.0.0) return 0 ;;
    *) return 1 ;;
  esac
}
if is_loopback_url "$SUPABASE_PUBLIC_URL"; then
  echo "ERROR: SUPABASE_PUBLIC_URL ($SUPABASE_PUBLIC_URL) is a loopback address." >&2
  echo "       It must be an origin reachable FROM INSIDE the containers — a LAN" >&2
  echo "       IP (e.g. http://192.168.1.100:8000) or a real FQDN — never" >&2
  echo "       localhost/127.0.0.1. Fix .env and re-run. See README.md section 2." >&2
  exit 1
fi
if [ -n "$API_EXTERNAL_URL" ] && is_loopback_url "$API_EXTERNAL_URL"; then
  echo "WARNING: API_EXTERNAL_URL ($API_EXTERNAL_URL) is a loopback address." >&2
  echo "         This only feeds OAuth/SAML callback links and the GOTRUE_JWT_ISSUER" >&2
  echo "         claim (not a container-to-container dial), so it is not fatal — but" >&2
  echo "         those links won't be clickable from outside this host." >&2
fi

DB_CONTAINER="${DB_CONTAINER:-supabase-db}"
PSQL() { docker exec -i "$DB_CONTAINER" psql -U supabase_admin -v ON_ERROR_STOP=1 -q "$@"; }
sqlq() { printf '%s' "$1" | sed "s/'/''/g"; }   # SQL single-quote escaping
enc()  { printf '%s' "$1" | openssl enc -aes-256-cbc -md md5 -base64 -A -pass env:PLATFORM_ENCRYPTION_KEY; }
# [self-platform] Escape \ and " for embedding a value into a curl -K
# double-quoted config line (see the no-argv-secrets calls in Phase 2).
cfg_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

echo "== Phase 1: _platform database =="
if ! PSQL -tAc "select 1 from pg_roles where rolname='platform_admin'" | grep -q 1; then
  # [self-platform] Password sent over stdin, not -c argv (visible via `ps`).
  printf '%s\n' "create role platform_admin login password '$(sqlq "$PLATFORM_POSTGRES_PASSWORD")'" | PSQL
  echo "created role platform_admin"
fi
if ! PSQL -tAc "select 1 from pg_database where datname='_platform'" | grep -q 1; then
  PSQL -c "create database _platform owner platform_admin"
  echo "created database _platform"
fi
PSQL -c "alter role platform_admin in database _platform set search_path = public, auth"
if ! PSQL -d _platform -tAc "select 1 from information_schema.tables where table_schema='platform' and table_name='projects'" | grep -q 1; then
  # [self-platform] Mirror volumes/db/platform-migrations.sql: 01-schema.sql
  # alters the postgres role's cluster-wide search_path. Capture it first,
  # elevate platform_admin for the window, and ALWAYS revoke + restore —
  # even if a migration file fails mid-loop.
  saved_sp=$(PSQL -tAc "select coalesce((select regexp_replace(cfg, '^search_path=', '') from unnest((select setconfig from pg_db_role_setting where setrole = 'postgres'::regrole and setdatabase = 0)) as u(cfg) where cfg like 'search_path=%'), '')")
  PSQL -c "alter role platform_admin createrole"
  PSQL -c "grant postgres to platform_admin with admin option"
  mig_rc=0
  for f in ../volumes/platform/migrations/*.sql; do
    echo "applying $(basename "$f")"
    if ! { echo "set role platform_admin;"; cat "$f"; } | PSQL -d _platform; then
      mig_rc=1
      break
    fi
  done
  PSQL -c "revoke postgres from platform_admin"
  PSQL -c "alter role platform_admin nocreaterole"
  if [ -n "$saved_sp" ]; then
    # Unquoted splice on purpose: the value is postgres' own catalog content;
    # a quoted literal would collapse the list into one element (see the
    # initdb wrapper's comment).
    PSQL -c "alter role postgres set search_path = $saved_sp"
  else
    PSQL -c "alter role postgres reset search_path"
  fi
  [ "$mig_rc" -eq 0 ] || { echo "ERROR: platform migration failed — elevation revoked and search_path restored; fix the cause and re-run" >&2; exit 1; }
else
  echo "platform schema present — skipping migrations (apply newer files manually; see README)"
fi

echo "== Phase 2: first admin =="
GOTRUE="$SUPABASE_PUBLIC_URL/platform-auth/v1"

echo "waiting for studio through kong..."
studio_ready=0
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "$SUPABASE_PUBLIC_URL/api/platform/telemetry/feature-flags"; then studio_ready=1; break; fi
  sleep 2
done
[ "$studio_ready" -eq 1 ] || { echo "ERROR: timed out waiting for studio at $SUPABASE_PUBLIC_URL (docker compose ps / logs studio)" >&2; exit 1; }

# Mint the short-lived service_role JWT only AFTER the stack is reachable —
# the wait loop above can take up to 120s, longer than the 60s token lifetime.
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
now=$(date +%s); exp=$((now + 60))
hdr=$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)
pay=$(printf '{"role":"service_role","iat":%d,"exp":%d}' "$now" "$exp" | b64url)
# -hmac puts the secret in argv for a sub-second window (ps-visible); openssl dgst has no env/stdin key option — accepted.
sig=$(printf '%s.%s' "$hdr" "$pay" | openssl dgst -binary -sha256 -hmac "$PLATFORM_JWT_SECRET" | b64url)
SVC_JWT="$hdr.$pay.$sig"

# [self-platform] Secrets never touch curl's own argv (visible via `ps`):
# headers and JSON bodies below are fed to curl's -K config parser over
# stdin instead of -H/-d. cfg_escape() escapes \ and " per curl's
# double-quoted config-value syntax.

# Create the admin (idempotent: 422 "already registered" tolerated).
admin_body="{\"email\":\"$PLATFORM_ADMIN_EMAIL\",\"password\":\"$PLATFORM_ADMIN_PASSWORD\",\"email_confirm\":true}"
{
  printf 'header = "Authorization: Bearer %s"\n' "$(cfg_escape "$SVC_JWT")"
  printf 'header = "Content-Type: application/json"\n'
  printf 'data = "%s"\n' "$(cfg_escape "$admin_body")"
} | curl -sS -K - -X POST -o /dev/null "$GOTRUE/admin/users" \
  || { echo "ERROR: platform GoTrue unreachable at $GOTRUE" >&2; exit 1; }

# No -f here (see below): we need the response body even on 4xx so the
# empty-TOKEN check can print the specific "wrong password?" diagnostic
# instead of curl aborting the script early on the bare HTTP error.
login_body="{\"email\":\"$PLATFORM_ADMIN_EMAIL\",\"password\":\"$PLATFORM_ADMIN_PASSWORD\"}"
token_json=$(
  {
    printf 'header = "Content-Type: application/json"\n'
    printf 'data = "%s"\n' "$(cfg_escape "$login_body")"
  } | curl -sS -K - -X POST "$GOTRUE/token?grant_type=password"
) || { echo "ERROR: platform GoTrue unreachable at $GOTRUE" >&2; exit 1; }
TOKEN=$(printf '%s' "$token_json" | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
[ -n "$TOKEN" ] || { echo "ERROR: admin login failed (wrong PLATFORM_ADMIN_PASSWORD for an existing user?)" >&2; exit 1; }

# [self-platform] Must be POST, not GET: the route 404s on GET until a
# profile row exists, and creation only happens in the POST branch
# (createProfileWithDefaultMembership — idempotent: on conflict do update /
# membership on conflict do nothing). This mirrors the client's own
# first-login mutation and also creates the default-org membership (M1).
printf 'header = "Authorization: Bearer %s"\n' "$(cfg_escape "$TOKEN")" \
  | curl -fsS -K - -X POST -o /dev/null "$SUPABASE_PUBLIC_URL/api/platform/profile"
PSQL -d _platform -c "insert into platform.member_roles (profile_id, role_id)
  select pr.id, 1 from platform.profiles pr
  where pr.primary_email = '$(sqlq "$PLATFORM_ADMIN_EMAIL")'
  on conflict do nothing;"
echo "admin $PLATFORM_ADMIN_EMAIL ready (Owner)"

echo "== Phase 3: register default project =="
LOGFLARE_URL_SQL="NULL"; LOGFLARE_TOKEN_SQL="NULL"; METRICS_URL_SQL="NULL"
if [ "$ENABLED_FEATURES_LOGS_ALL" = "true" ]; then
  LOGFLARE_URL_SQL="'http://analytics:4000'"
  [ -n "$LOGFLARE_PRIVATE_ACCESS_TOKEN" ] && LOGFLARE_TOKEN_SQL="'$(sqlq "$(enc "$LOGFLARE_PRIVATE_ACCESS_TOKEN")")'"
  METRICS_URL_SQL="'http://vector:9598'"
fi
PUB_SQL="NULL"; SEC_SQL="NULL"
[ -n "$SUPABASE_PUBLISHABLE_KEY" ] && PUB_SQL="'$(sqlq "$(enc "$SUPABASE_PUBLISHABLE_KEY")")'"
[ -n "$SUPABASE_SECRET_KEY" ] && SEC_SQL="'$(sqlq "$(enc "$SUPABASE_SECRET_KEY")")'"

PSQL -d _platform <<SQL
insert into platform.projects
  (ref, organization_id, name, status, cloud_provider, region,
   db_host, db_port, db_name, db_user, db_user_readonly, kong_url, rest_url,
   db_pass_enc, service_key_enc, anon_key_enc, jwt_secret_enc,
   publishable_key_enc, secret_key_enc, logflare_url, logflare_token_enc,
   metrics_url, metrics_token_enc, stack_kind, container_name, k8s_namespace, k8s_pod_selector)
values
  ('default', (select id from platform.organizations where slug='default'),
   '$(sqlq "$PROJECT_NAME")', 'ACTIVE_HEALTHY', 'AWS', 'local',
   'db', $POSTGRES_PORT, '$(sqlq "$POSTGRES_DB")', 'supabase_admin', 'supabase_read_only_user',
   '$(sqlq "$SUPABASE_PUBLIC_URL")', '$(sqlq "$SUPABASE_PUBLIC_URL")/rest/v1/',
   '$(sqlq "$(enc "$POSTGRES_PASSWORD")")', '$(sqlq "$(enc "$SERVICE_ROLE_KEY")")',
   '$(sqlq "$(enc "$ANON_KEY")")', '$(sqlq "$(enc "$JWT_SECRET")")',
   $PUB_SQL, $SEC_SQL, $LOGFLARE_URL_SQL, $LOGFLARE_TOKEN_SQL,
   $METRICS_URL_SQL, NULL, 'external', 'supabase-db', NULL, NULL)
-- Intentionally narrower than register-project.ts buildUpsertSql():
-- k8s_namespace/k8s_pod_selector/metrics_token_enc are panel/CLI-owned
-- and must survive bootstrap re-runs.
on conflict (ref) do update set
  name=excluded.name, status=excluded.status,
  db_host=excluded.db_host, db_port=excluded.db_port, db_name=excluded.db_name,
  db_user=excluded.db_user, db_user_readonly=excluded.db_user_readonly,
  kong_url=excluded.kong_url, rest_url=excluded.rest_url,
  db_pass_enc=excluded.db_pass_enc, service_key_enc=excluded.service_key_enc,
  anon_key_enc=excluded.anon_key_enc, jwt_secret_enc=excluded.jwt_secret_enc,
  publishable_key_enc=excluded.publishable_key_enc, secret_key_enc=excluded.secret_key_enc,
  logflare_url=excluded.logflare_url, logflare_token_enc=excluded.logflare_token_enc,
  metrics_url=excluded.metrics_url,
  stack_kind=excluded.stack_kind, container_name=excluded.container_name,
  updated_at=now();
SQL
echo "default project registered"
echo "== bootstrap complete =="
