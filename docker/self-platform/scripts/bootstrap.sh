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
envval() { grep -E "^$1=" .env | head -1 | cut -d= -f2-; }

POSTGRES_PASSWORD="$(envval POSTGRES_PASSWORD)"
POSTGRES_PORT="$(envval POSTGRES_PORT)"
POSTGRES_DB="$(envval POSTGRES_DB)"
JWT_SECRET="$(envval JWT_SECRET)"
ANON_KEY="$(envval ANON_KEY)"
SERVICE_ROLE_KEY="$(envval SERVICE_ROLE_KEY)"
SUPABASE_PUBLIC_URL="$(envval SUPABASE_PUBLIC_URL)"; SUPABASE_PUBLIC_URL="${SUPABASE_PUBLIC_URL%/}"
SUPABASE_PUBLISHABLE_KEY="$(envval SUPABASE_PUBLISHABLE_KEY)"
SUPABASE_SECRET_KEY="$(envval SUPABASE_SECRET_KEY)"
PLATFORM_POSTGRES_PASSWORD="$(envval PLATFORM_POSTGRES_PASSWORD)"
PLATFORM_JWT_SECRET="$(envval PLATFORM_JWT_SECRET)"
PLATFORM_ENCRYPTION_KEY="$(envval PLATFORM_ENCRYPTION_KEY)"
PLATFORM_ADMIN_EMAIL="$(envval PLATFORM_ADMIN_EMAIL)"
PLATFORM_ADMIN_PASSWORD="$(envval PLATFORM_ADMIN_PASSWORD)"
LOGFLARE_PRIVATE_ACCESS_TOKEN="$(envval LOGFLARE_PRIVATE_ACCESS_TOKEN)"
ENABLED_FEATURES_LOGS_ALL="$(envval ENABLED_FEATURES_LOGS_ALL)"
PROJECT_NAME="$(envval STUDIO_DEFAULT_PROJECT)"; PROJECT_NAME="${PROJECT_NAME:-Default Project}"

for v in POSTGRES_PASSWORD SUPABASE_PUBLIC_URL PLATFORM_POSTGRES_PASSWORD \
         PLATFORM_JWT_SECRET PLATFORM_ENCRYPTION_KEY PLATFORM_ADMIN_EMAIL \
         PLATFORM_ADMIN_PASSWORD SERVICE_ROLE_KEY ANON_KEY JWT_SECRET; do
  [ -n "$(eval "printf '%s' \"\$$v\"")" ] || { echo "ERROR: $v is empty in .env" >&2; exit 1; }
done

DB_CONTAINER="${DB_CONTAINER:-supabase-db}"
PSQL() { docker exec -i "$DB_CONTAINER" psql -U supabase_admin -v ON_ERROR_STOP=1 -q "$@"; }
sqlq() { printf '%s' "$1" | sed "s/'/''/g"; }   # SQL single-quote escaping
enc()  { printf '%s' "$1" | openssl enc -aes-256-cbc -md md5 -base64 -A -pass pass:"$PLATFORM_ENCRYPTION_KEY"; }

echo "== Phase 1: _platform database =="
if ! PSQL -tAc "select 1 from pg_roles where rolname='platform_admin'" | grep -q 1; then
  PSQL -c "create role platform_admin login password '$(sqlq "$PLATFORM_POSTGRES_PASSWORD")'"
  echo "created role platform_admin"
fi
if ! PSQL -tAc "select 1 from pg_database where datname='_platform'" | grep -q 1; then
  PSQL -c "create database _platform owner platform_admin"
  echo "created database _platform"
fi
PSQL -c "alter role platform_admin in database _platform set search_path = public, auth"
if ! PSQL -d _platform -tAc "select 1 from information_schema.tables where table_schema='platform' and table_name='projects'" | grep -q 1; then
  for f in ../volumes/platform/migrations/*.sql; do
    echo "applying $(basename "$f")"
    { echo "set role platform_admin;"; cat "$f"; } | PSQL -d _platform
  done
else
  echo "platform schema present — skipping migrations (apply newer files manually; see README)"
fi

echo "== Phase 2: first admin =="
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
now=$(date +%s); exp=$((now + 60))
hdr=$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)
pay=$(printf '{"role":"service_role","iat":%d,"exp":%d}' "$now" "$exp" | b64url)
sig=$(printf '%s.%s' "$hdr" "$pay" | openssl dgst -binary -sha256 -hmac "$PLATFORM_JWT_SECRET" | b64url)
SVC_JWT="$hdr.$pay.$sig"
GOTRUE="$SUPABASE_PUBLIC_URL/platform-auth/v1"

echo "waiting for studio through kong..."
for _ in $(seq 1 60); do
  curl -fsS -o /dev/null "$SUPABASE_PUBLIC_URL/api/platform/telemetry/feature-flags" && break
  sleep 2
done

# Create the admin (idempotent: 422 "already registered" tolerated).
curl -sS -o /tmp/plt-admin-create.json -X POST "$GOTRUE/admin/users" \
  -H "Authorization: Bearer $SVC_JWT" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$PLATFORM_ADMIN_EMAIL\",\"password\":\"$PLATFORM_ADMIN_PASSWORD\",\"email_confirm\":true}" \
  || { echo "ERROR: platform GoTrue unreachable at $GOTRUE" >&2; exit 1; }

TOKEN=$(curl -fsS -X POST "$GOTRUE/token?grant_type=password" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$PLATFORM_ADMIN_EMAIL\",\"password\":\"$PLATFORM_ADMIN_PASSWORD\"}" \
  | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
[ -n "$TOKEN" ] || { echo "ERROR: admin login failed (wrong PLATFORM_ADMIN_PASSWORD for an existing user?)" >&2; exit 1; }

# First profile fetch auto-creates platform.profiles + default-org membership (M1).
curl -fsS -o /dev/null "$SUPABASE_PUBLIC_URL/api/platform/profile" -H "Authorization: Bearer $TOKEN"
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
