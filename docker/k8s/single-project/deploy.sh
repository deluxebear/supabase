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
