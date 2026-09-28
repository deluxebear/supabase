#!/usr/bin/env bash
# Deploy a full single-project Supabase stack onto a k8s cluster, faithful to the
# repo's docker/docker-compose.yml (fork db image deluxebear/postgres:17), plus a
# cAdvisor DaemonSet for container_* metrics. Secrets come from docker/.env — this
# script builds a Secret + the file-backed ConfigMaps from repo files, then applies
# the (secret-free) manifests. Idempotent: re-run to converge.
#
#   ./deploy.sh            # deploy to the current kube-context, namespace 'supabase'
#
# Verified live on single-node k3s v1.36.2 (containerd, amd64) 2026-07-08.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DOCKER_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"   # repo docker/
NS=supabase
ENV_FILE="$DOCKER_DIR/.env"

[ -f "$ENV_FILE" ] || { echo "ERROR: $ENV_FILE not found (copy docker/.env.example → docker/.env first)"; exit 1; }

echo "==> namespace"
kubectl apply -f "$SCRIPT_DIR/00-namespace.yaml"

echo "==> Secret supabase-env (from docker/.env — all keys; consumed via secretKeyRef)"
kubectl create secret generic supabase-env -n "$NS" \
  --from-env-file="$ENV_FILE" --dry-run=client -o yaml | kubectl apply -f -

echo "==> Secret auth-defaults (configurable GoTrue settings; a Fleet Agent may override them)"
# Maps docker/.env keys to the GoTrue variables that 11-core.yaml used to set
# with `env`. Values are copied verbatim, as --from-env-file does. A key missing
# from docker/.env is left out, so GoTrue uses its own default.
AUTH_DEFAULTS="$(mktemp)"
trap 'rm -f "$AUTH_DEFAULTS"' EXIT
while read -r target source; do
  line="$(grep -E "^${source}=" "$ENV_FILE" | tail -1 || true)"
  if [ -n "$line" ]; then printf '%s=%s\n' "$target" "${line#*=}" >> "$AUTH_DEFAULTS"; fi
done <<'MAP'
GOTRUE_SITE_URL SITE_URL
GOTRUE_URI_ALLOW_LIST ADDITIONAL_REDIRECT_URLS
GOTRUE_DISABLE_SIGNUP DISABLE_SIGNUP
GOTRUE_JWT_EXP JWT_EXPIRY
GOTRUE_EXTERNAL_EMAIL_ENABLED ENABLE_EMAIL_SIGNUP
GOTRUE_EXTERNAL_ANONYMOUS_USERS_ENABLED ENABLE_ANONYMOUS_USERS
GOTRUE_MAILER_AUTOCONFIRM ENABLE_EMAIL_AUTOCONFIRM
GOTRUE_SMTP_ADMIN_EMAIL SMTP_ADMIN_EMAIL
GOTRUE_SMTP_HOST SMTP_HOST
GOTRUE_SMTP_PORT SMTP_PORT
GOTRUE_SMTP_USER SMTP_USER
GOTRUE_SMTP_PASS SMTP_PASS
GOTRUE_SMTP_SENDER_NAME SMTP_SENDER_NAME
GOTRUE_MAILER_URLPATHS_INVITE MAILER_URLPATHS_INVITE
GOTRUE_MAILER_URLPATHS_CONFIRMATION MAILER_URLPATHS_CONFIRMATION
GOTRUE_MAILER_URLPATHS_RECOVERY MAILER_URLPATHS_RECOVERY
GOTRUE_MAILER_URLPATHS_EMAIL_CHANGE MAILER_URLPATHS_EMAIL_CHANGE
GOTRUE_EXTERNAL_PHONE_ENABLED ENABLE_PHONE_SIGNUP
GOTRUE_SMS_AUTOCONFIRM ENABLE_PHONE_AUTOCONFIRM
MAP
kubectl create secret generic auth-defaults -n "$NS" \
  --from-env-file="$AUTH_DEFAULTS" --dry-run=client -o yaml | kubectl apply -f -

echo "==> ConfigMap db-init (init SQL keyed by target filename, mounted via subPath)"
kubectl create configmap db-init -n "$NS" \
  --from-file=99-realtime.sql="$DOCKER_DIR/volumes/db/realtime.sql" \
  --from-file=97-_supabase.sql="$DOCKER_DIR/volumes/db/_supabase.sql" \
  --from-file=99-logs.sql="$DOCKER_DIR/volumes/db/logs.sql" \
  --from-file=99-pooler.sql="$DOCKER_DIR/volumes/db/pooler.sql" \
  --from-file=98-webhooks.sql="$DOCKER_DIR/volumes/db/webhooks.sql" \
  --from-file=99-roles.sql="$DOCKER_DIR/volumes/db/roles.sql" \
  --from-file=99-jwt.sql="$DOCKER_DIR/volumes/db/jwt.sql" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "==> ConfigMap kong-config (declarative config + custom entrypoint)"
kubectl create configmap kong-config -n "$NS" \
  --from-file=kong.yml="$DOCKER_DIR/volumes/api/kong.yml" \
  --from-file=kong-entrypoint.sh="$DOCKER_DIR/volumes/api/kong-entrypoint.sh" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "==> ConfigMap functions-main (edge-runtime main service; mounted via subPath)"
kubectl create configmap functions-main -n "$NS" \
  --from-file=index.ts="$DOCKER_DIR/volumes/functions/main/index.ts" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "==> ConfigMap pooler-config (supavisor pooler.exs)"
kubectl create configmap pooler-config -n "$NS" \
  --from-file=pooler.exs="$DOCKER_DIR/volumes/pooler/pooler.exs" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "==> workloads (db + cAdvisor first, then the rest)"
kubectl apply -f "$SCRIPT_DIR/03-db.yaml" -f "$SCRIPT_DIR/04-cadvisor.yaml"
kubectl -n "$NS" rollout status statefulset/supabase-db --timeout=360s
kubectl apply \
  -f "$SCRIPT_DIR/11-core.yaml" \
  -f "$SCRIPT_DIR/12-storage.yaml" \
  -f "$SCRIPT_DIR/13-realtime.yaml" \
  -f "$SCRIPT_DIR/15-kong.yaml" \
  -f "$SCRIPT_DIR/18-studio.yaml" \
  -f "$SCRIPT_DIR/19-functions.yaml" \
  -f "$SCRIPT_DIR/20-supavisor.yaml"

echo "==> waiting for the stack to converge"
kubectl -n "$NS" wait --for=condition=Available deploy --all --timeout=300s || true
kubectl -n "$NS" get pods
echo "==> kong gateway:"
kubectl -n "$NS" get svc kong
