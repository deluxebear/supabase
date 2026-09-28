#!/usr/bin/env bash
# Deploy a Fleet Agent into the `supabase` namespace next to the single-project
# stack (../single-project). Idempotent: re-run to converge.
#
#   ./deploy.sh [path/to/fleet-agent.env]      # default: ./fleet-agent.env
#
# 1. ConfigMap fleet-agent-identity from the env file (no secrets).
# 2. RBAC, state volume, and the capability list.
# 3. Enrollment, once: the Job exchanges the single-use token for the mTLS
#    certificate on the state volume. The ConfigMap fleet-agent-enrollment-state
#    records that it succeeded, and the token Secret is deleted afterwards.
#    Enrollment never overwrites existing trust files, so enrolling again (for
#    example after the Agent was revoked) needs a new state volume: delete the
#    Deployment, the PVC fleet-agent-state, and that ConfigMap, then re-run
#    with a new token. A new volume also means a new secret recipient key, so
#    apply sealed secrets again from Studio afterwards.
# 4. The Agent Deployment, then the functions Deployment patched to serve the
#    shared function volume on the Agent's node.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${1:-$SCRIPT_DIR/fleet-agent.env}"
NS=supabase
PATCH_FILE="$(mktemp)"
trap 'rm -f "$PATCH_FILE"' EXIT

[ -f "$ENV_FILE" ] || { echo "ERROR: $ENV_FILE not found (copy fleet-agent.env.example first)" >&2; exit 1; }
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a

required=(FLEET_AGENT_IMAGE FLEET_AGENT_ORGANIZATION_ID FLEET_AGENT_PROJECT_REF FLEET_AGENT_TARGET_ID
  FLEET_AGENT_BINDING_ID FLEET_AGENT_ID FLEET_AGENT_EXECUTION_TARGET FLEET_AGENT_NODE_ID
  FLEET_AGENT_CONTROL_ADDRESS FLEET_AGENT_SERVER_NAME FLEET_AGENT_ENROLLMENT_URL
  FLEET_AGENT_KUBERNETES_SECRET_SERVICES FLEET_AGENT_KUBERNETES_LIFECYCLE_SERVICES
  FLEET_AGENT_LIFECYCLE_COMPONENT_VERSIONS)
for name in "${required[@]}"; do
  [ -n "${!name:-}" ] || { echo "ERROR: $name is not set in $ENV_FILE" >&2; exit 1; }
done

# Manifests name the image FLEET_AGENT_IMAGE; substitute it on the way in.
render() { sed "s|image: FLEET_AGENT_IMAGE|image: ${FLEET_AGENT_IMAGE}|" "$1"; }

echo "==> namespace"
kubectl apply -f "$SCRIPT_DIR/../single-project/00-namespace.yaml"

echo "==> ConfigMap fleet-agent-identity"
kubectl create configmap fleet-agent-identity -n "$NS" \
  --from-literal=FLEET_AGENT_ORGANIZATION_ID="$FLEET_AGENT_ORGANIZATION_ID" \
  --from-literal=FLEET_AGENT_PROJECT_REF="$FLEET_AGENT_PROJECT_REF" \
  --from-literal=FLEET_AGENT_TARGET_ID="$FLEET_AGENT_TARGET_ID" \
  --from-literal=FLEET_AGENT_BINDING_ID="$FLEET_AGENT_BINDING_ID" \
  --from-literal=FLEET_AGENT_ID="$FLEET_AGENT_ID" \
  --from-literal=FLEET_AGENT_EXECUTION_TARGET="$FLEET_AGENT_EXECUTION_TARGET" \
  --from-literal=FLEET_AGENT_NODE_ID="$FLEET_AGENT_NODE_ID" \
  --from-literal=FLEET_AGENT_CONTROL_ADDRESS="$FLEET_AGENT_CONTROL_ADDRESS" \
  --from-literal=FLEET_AGENT_SERVER_NAME="$FLEET_AGENT_SERVER_NAME" \
  --from-literal=FLEET_AGENT_ENROLLMENT_URL="$FLEET_AGENT_ENROLLMENT_URL" \
  --from-literal=FLEET_AGENT_KUBERNETES_SECRET_SERVICES="$FLEET_AGENT_KUBERNETES_SECRET_SERVICES" \
  --from-literal=FLEET_AGENT_KUBERNETES_LIFECYCLE_SERVICES="$FLEET_AGENT_KUBERNETES_LIFECYCLE_SERVICES" \
  --from-literal=FLEET_AGENT_LIFECYCLE_COMPONENT_VERSIONS="$FLEET_AGENT_LIFECYCLE_COMPONENT_VERSIONS" \
  --dry-run=client -o yaml | kubectl apply -f -

echo "==> ConfigMap fleet-database-tls-ca (CA files Supavisor may verify Postgres with)"
# Studio refers to a CA by file name; only files in this ConfigMap are allowed.
if [ -n "${FLEET_AGENT_DATABASE_TLS_CA_DIR:-}" ]; then
  case "$FLEET_AGENT_DATABASE_TLS_CA_DIR" in /*) CA_DIR="$FLEET_AGENT_DATABASE_TLS_CA_DIR" ;; *) CA_DIR="$(dirname "$ENV_FILE")/$FLEET_AGENT_DATABASE_TLS_CA_DIR" ;; esac
  kubectl create configmap fleet-database-tls-ca -n "$NS" --from-file="$CA_DIR" \
    --dry-run=client -o yaml | kubectl apply -f -
else
  kubectl create configmap fleet-database-tls-ca -n "$NS" --dry-run=client -o yaml | kubectl apply -f -
fi

echo "==> RBAC, state and function volumes, capabilities"
kubectl apply -f "$SCRIPT_DIR/10-rbac.yaml" -f "$SCRIPT_DIR/20-state.yaml" -f "$SCRIPT_DIR/25-functions-volume.yaml"

if kubectl get configmap fleet-agent-enrollment-state -n "$NS" >/dev/null 2>&1; then
  echo "==> already enrolled (ConfigMap fleet-agent-enrollment-state exists)"
else
  echo "==> enrollment"
  # The enrollment Job needs the ReadWriteOnce state volume to itself.
  if kubectl get deployment fleet-agent -n "$NS" >/dev/null 2>&1; then
    kubectl scale deployment fleet-agent -n "$NS" --replicas=0
    kubectl wait -n "$NS" --for=delete pod -l app=fleet-agent --timeout=120s || true
  fi
  [ -n "${FLEET_AGENT_ENROLLMENT_TOKEN:-}" ] || { echo "ERROR: FLEET_AGENT_ENROLLMENT_TOKEN is required to enroll" >&2; exit 1; }
  CA_FILE="${FLEET_AGENT_ENROLLMENT_CA_FILE:-}"
  case "$CA_FILE" in /*) ;; *) CA_FILE="$(dirname "$ENV_FILE")/$CA_FILE" ;; esac
  [ -f "$CA_FILE" ] || { echo "ERROR: enrollment CA $CA_FILE not found" >&2; exit 1; }
  kubectl create secret generic fleet-agent-enrollment -n "$NS" \
    --from-literal=token="$FLEET_AGENT_ENROLLMENT_TOKEN" \
    --from-file=ca.crt="$CA_FILE" \
    --dry-run=client -o yaml | kubectl apply -f -
  # A finished Job cannot be re-run; remove a previous failed attempt.
  kubectl delete job fleet-agent-enroll -n "$NS" --ignore-not-found
  render "$SCRIPT_DIR/30-enroll-job.yaml" | kubectl apply -f -
  if ! kubectl wait -n "$NS" --for=condition=complete job/fleet-agent-enroll --timeout=180s; then
    kubectl logs -n "$NS" job/fleet-agent-enroll || true
    echo "ERROR: enrollment failed. Tokens are single use: request a new one before retrying." >&2
    exit 1
  fi
  kubectl create configmap fleet-agent-enrollment-state -n "$NS" \
    --from-literal=agentId="$FLEET_AGENT_ID" --from-literal=bindingId="$FLEET_AGENT_BINDING_ID"
  kubectl delete secret fleet-agent-enrollment -n "$NS"
  kubectl delete job fleet-agent-enroll -n "$NS"
fi

echo "==> Agent"
render "$SCRIPT_DIR/40-agent.yaml" | kubectl apply -f -
kubectl rollout status -n "$NS" deployment/fleet-agent --timeout=180s

echo "==> functions Deployment serves the shared function volume"
# The Agent's per-project directory: the first 12 bytes of SHA-256(project ref).
PROJECT_KEY="$(printf '%s' "$FLEET_AGENT_PROJECT_REF" | sha256sum | cut -c1-24)"
sed "s|FLEET_FUNCTION_PROJECT_KEY|${PROJECT_KEY}|g" "$SCRIPT_DIR/functions-patch.yaml" > "$PATCH_FILE"
kubectl patch deployment functions -n "$NS" --type=strategic --patch-file="$PATCH_FILE"
kubectl rollout status -n "$NS" deployment/functions --timeout=180s
echo "Fleet Agent is running. Check Studio: the project binding should report the Agent online."
