#!/usr/bin/env bash
set -euo pipefail

BACKUP_OPERATOR_SETUP_ONLY=1
# shellcheck source=../../spikes/kubernetes-replacement.sh
source "$(dirname "$0")/../../spikes/kubernetes-replacement.sh" "${1:-pg17}"

failure_diagnostics() {
  local line="$1"
  printf 'CAPABILITY_BLOCKER=Kubernetes product-chain E2E failed at line %s\n' "$line" >&2
  [ ! -f "${operator_log:-}" ] || { printf '%s\n' '--- backup-operator.log ---' >&2; cat "$operator_log" >&2; }
  kubectl -n "$namespace" get pvc,job,pod,statefulset,service -o wide >&2 2>/dev/null || true
  kubectl -n "$namespace" get job -o yaml >&2 2>/dev/null || true
  kubectl -n "$namespace" get pvc -o yaml >&2 2>/dev/null || true
  kubectl -n "$namespace" get configmap pgbackrest-spike -o yaml >&2 2>/dev/null || true
  while IFS= read -r pod; do
    printf '%s\n' "--- $pod ---" >&2
    kubectl -n "$namespace" describe "$pod" >&2 2>/dev/null || true
    kubectl -n "$namespace" logs "$pod" --all-containers >&2 2>/dev/null || true
  done < <(kubectl -n "$namespace" get pod -l backup.supabase.com/recovery-plan -o name 2>/dev/null || true)
}
trap 'failure_diagnostics "$LINENO"' ERR

source_pvc_uid="$(kubectl -n "$namespace" get pvc source-data -o jsonpath='{.metadata.uid}')"
source_pv_name="$(kubectl -n "$namespace" get pvc source-data -o jsonpath='{.spec.volumeName}')"
source_system_id="$(kubectl -n "$namespace" exec source-0 -- pg_controldata /var/lib/postgresql/data | awk -F: '/Database system identifier/{gsub(/ /,"",$2); print $2}')"
source_timeline="$(kubectl -n "$namespace" exec source-0 -- psql -U postgres -Atqc 'SELECT timeline_id FROM pg_control_checkpoint()')"
kubectl -n "$namespace" annotate pod source-0 --overwrite \
  backup.supabase.com/role=primary \
  "backup.supabase.com/system-identifier=$source_system_id" \
  "backup.supabase.com/timeline=$source_timeline" \
  backup.supabase.com/lag-bytes=0 >/dev/null
[ "$(query_service pitr-route before-target,after-target)" = before-target,after-target ]

for _ in $(seq 1 60); do
  quota_hard="$(kubectl -n "$namespace" get resourcequota replacement-storage -o jsonpath='{.status.hard.requests\.storage}' 2>/dev/null || true)"
  [ -n "$quota_hard" ] && break
  sleep 1
done
[ -n "$quota_hard" ] || { printf 'CAPABILITY_BLOCKER=ResourceQuota status unavailable\n' >&2; exit 69; }

control_db="$tmp/control.db"
(cd "$(dirname "$0")/../.." && go run ./test/e2e/seed-observation \
  --dsn "$control_db" --project kubernetes-e2e --target kubernetes-database \
  --system-id "$source_system_id" --repository backup-repository --backup-id "$backup_id" \
  --stanza k8s-spike \
  --completed-at "$backup_completed_at" --recoverable-until "$recoverable_until")

read -r operator_port control_port < <(python3 - <<'PY'
import socket
ports=[]
for _ in range(2):
    s=socket.socket(); s.bind(('127.0.0.1',0)); ports.append(str(s.getsockname()[1])); s.close()
print(' '.join(ports))
PY
)
control_log="$tmp/control-adapter.log"
python3 - "$control_port" "$control_log" <<'PY' &
import http.server,sys
port,log=int(sys.argv[1]),sys.argv[2]
class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body=self.rfile.read(int(self.headers.get('content-length','0')))
        with open(log,'ab') as output: output.write(self.path.encode()+b' '+body+b'\n')
        self.send_response(204); self.end_headers()
    def log_message(self,*args): pass
http.server.ThreadingHTTPServer(('127.0.0.1',port),Handler).serve_forever()
PY
control_pid=$!

operator_bin="$tmp/backup-operator"
(cd "$(dirname "$0")/../.." && go build -o "$operator_bin" ./cmd/backup-operator)
kind get kubeconfig --name "$cluster" >"$tmp/kubeconfig"
assertion_key='01234567890123456789012345678901'
operator_url="http://127.0.0.1:$operator_port"
operator_log="$tmp/operator.log"
project_id='kubernetes-e2e'
target_id='kubernetes-database'
# shellcheck source=lib/product-chain.sh
source "$(dirname "$0")/lib/product-chain.sh"
"$operator_bin" --mode all --listen "127.0.0.1:$operator_port" \
  --control-store-dsn "$control_db" --service-assertion-key "$assertion_key" \
  --runtime-enable --runtime-poll-interval 200ms --runtime-lease-ttl 2s \
  --kubernetes-enable --kubernetes-kubeconfig "$tmp/kubeconfig" \
  --kubernetes-namespace "$namespace" --kubernetes-project "$project_id" \
  --kubernetes-target "$target_id" --kubernetes-statefulset source \
  --kubernetes-image "$image" --kubernetes-pgbackrest-version "$pgbackrest_version" \
  --kubernetes-pgbackrest-config e2e-observed-v1 \
  --kubernetes-stable-service pitr-route --kubernetes-isolated-service recovered-isolated \
  --kubernetes-pgbackrest-config-map pgbackrest-spike \
  --kubernetes-pgbackrest-repository-pvc backup-repository \
  --kubernetes-pgsodium-secret pgsodium-root \
  --kubernetes-storage-class standard \
  --kubernetes-pgbackrest-stanza k8s-spike --kubernetes-archive-identity recovery-history \
  --kubernetes-registry-url "http://127.0.0.1:$control_port/registry" \
  --kubernetes-cleanup-delay 1h >"$operator_log" 2>&1 &
operator_pid=$!
wait_operator_ready

capabilities="$(operator_request GET /v1/capabilities)"
jq -e '.[] | select(.name=="custom-postgres-kubernetes") | .supported == true' <<<"$capabilities" >/dev/null || {
  printf 'Kubernetes capability is blocked: %s\n' "$capabilities" >&2; false;
}
jq -e '.[] | select(.name=="destructive-restore") | .supported == true' <<<"$capabilities" >/dev/null
operator_request POST /v1/clusters \
  "$(jq -cn --arg project "$project_id" --arg target "$target_id" --arg system "$source_system_id" \
    '{projectId:$project,targetId:$target,systemIdentifier:$system,dataDomain:"kubernetes-pgdata"}')" >/dev/null
execute_restore_through_product "$recovery_target"

replacement="$(kubectl -n "$namespace" get statefulset -l "backup.supabase.com/recovery-plan=$plan_id" -o jsonpath='{.items[0].metadata.name}')"
[ -n "$replacement" ]
replacement_pod="$replacement-0"
kubectl -n "$namespace" wait --for=condition=Ready "pod/$replacement_pod" --timeout=240s >/dev/null
recovered_pvc="$(kubectl -n "$namespace" get pvc -l "backup.supabase.com/recovery-plan=$plan_id" -o jsonpath='{.items[0].metadata.name}')"
recovered_pvc_uid="$(kubectl -n "$namespace" get pvc "$recovered_pvc" -o jsonpath='{.metadata.uid}')"
isolated_result="$(query_service_from_pod "$replacement_pod" recovered-isolated before-target)"
cutover_result="$(query_service_from_pod "$replacement_pod" pitr-route before-target)"
recovered_system_id="$(kubectl -n "$namespace" exec "$replacement_pod" -- pg_controldata /var/lib/postgresql/data/pgdata | awk -F: '/Database system identifier/{gsub(/ /,"",$2); print $2}')"
[ "$isolated_result" = before-target ]
[ "$cutover_result" = before-target ]
[ "$recovered_pvc_uid" != "$source_pvc_uid" ]
[ "$recovered_system_id" = "$source_system_id" ]

rollback_restore_through_product
kubectl -n "$namespace" rollout status statefulset/source --timeout=240s >/dev/null
rollback_result="$(query_service pitr-route before-target,after-target)"
[ "$rollback_result" = before-target,after-target ]
[ "$(kubectl -n "$namespace" get pvc source-data -o jsonpath='{.metadata.uid}')" = "$source_pvc_uid" ]
[ "$(kubectl -n "$namespace" get pvc source-data -o jsonpath='{.spec.volumeName}')" = "$source_pv_name" ]

printf 'variant=%s\nprovider=custom-image-%s\n' "$variant" "${pgbackrest_version// /-}"
printf 'plan_id=%s\njob_id=%s\nproduct_chain=signed-plan-confirm-execute-outbox-taskrouter\n' "$plan_id" "$job_id"
printf 'source_pvc_uid=%s\nrecovered_pvc_uid=%s\n' "$source_pvc_uid" "$recovered_pvc_uid"
printf 'switched_wal=%s\nlast_archived_wal=%s\n' "$switched_wal" "$last_archived_wal"
printf 'system_identifier=%s\n' "$source_system_id"
printf 'isolated_validation=%s\ncutover_validation=%s\nrollback_validation=%s\n' "$isolated_result" "$cutover_result" "$rollback_result"
printf 'RESULT=PASS\n'
