#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

compose_config="$(
  BACKUP_OPERATOR_VERSION=v0.0.0-validation \
    BACKUP_OPERATOR_SERVICE_ASSERTION_KEY=validation-only-at-least-32-bytes \
    docker compose -f "$root/deploy/compose.yaml" config --format json
)"
if jq -e '.services | has("backup-agent")' <<<"$compose_config" >/dev/null; then
  echo "default Compose deployment must use the host systemd Agent, not a containerized backup-agent" >&2
  exit 1
fi
jq -e '
  .services["backup-operator"] as $operator
  | ($operator.command | index("--listen=0.0.0.0:8080")) != null
    and ($operator.ports | any(.host_ip == "127.0.0.1" and .target == 8080))
    and ($operator.read_only == true)
' <<<"$compose_config" >/dev/null
helm lint "$root/deploy/helm/backup-operator" --set image.tag=v0.0.0-validation
helm_output="$(helm template validation "$root/deploy/helm/backup-operator" --set image.tag=v0.0.0-validation)"
kustomize_output="$(kubectl kustomize "$root/deploy")"
for output in "$helm_output" "$kustomize_output"; do
  grep -q 'name: BACKUP_OPERATOR_SERVICE_ASSERTION_KEY' <<<"$output"
  grep -q 'secretKeyRef:' <<<"$output"
  grep -q 'name: BACKUP_OPERATOR_RUNTIME_ENABLED' <<<"$output"
  grep -q 'claimName:' <<<"$output"
  grep -q 'readOnlyRootFilesystem: true' <<<"$output"
  grep -q 'path: /readyz' <<<"$output"
  grep -q 'path: /healthz' <<<"$output"
done
grep -q 'kind: Role' <<<"$kustomize_output"
grep -q 'kind: RoleBinding' <<<"$kustomize_output"

if command -v systemd-analyze >/dev/null 2>&1; then
  for unit in "$root/deploy/systemd/backup-operator.service" "$root/deploy/systemd/backup-agent.service"; do
    systemd-analyze verify "$unit" 2> >(grep -v 'Command .* is not executable' >&2 || true)
  done
else
  echo "systemd-analyze is unavailable; systemd verification is deferred to Linux CI" >&2
fi
