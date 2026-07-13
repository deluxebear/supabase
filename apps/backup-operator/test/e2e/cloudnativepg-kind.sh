#!/usr/bin/env bash
set -Eeuo pipefail

cluster="cnpg-pitr-e2e-$(date +%s)-$$"
namespace="cnpg-e2e"
tmp="$(mktemp -d)"
cnpg_version="1.29.1"
cert_manager_version="1.17.0"
barman_version="0.13.0"
minio_image="minio/minio:RELEASE.2025-04-22T22-12-26Z"
minio_mc_image="minio/mc:RELEASE.2025-04-16T18-13-26Z"
kind_lock="${TMPDIR:-/tmp}/supabase-backup-operator-kind-e2e.lock"
cluster_created=0

if ! mkdir "$kind_lock" 2>/dev/null; then
  printf 'CAPABILITY_BLOCKER=another backup-operator Kind E2E owns %s\n' "$kind_lock" >&2
  [ ! -f "$kind_lock/owner" ] || { printf 'current owner: ' >&2; cat "$kind_lock/owner" >&2; }
  exit 75
fi
printf 'pid=%s cluster=%s script=%s\n' "$$" "$cluster" "${BASH_SOURCE[0]}" >"$kind_lock/owner"

cleanup() {
  [ -z "${operator_pid:-}" ] || kill "$operator_pid" >/dev/null 2>&1 || true
  [ -z "${control_pid:-}" ] || kill "$control_pid" >/dev/null 2>&1 || true
  if [ "$cluster_created" = 1 ] && kind get clusters 2>/dev/null | grep -Fqx "$cluster"; then
    kind delete cluster --name "$cluster" >/dev/null 2>&1 || true
  fi
  rm -rf "$tmp"
  rm -rf "$kind_lock"
}
failure_diagnostics() {
  local line="$1"
  printf 'CAPABILITY_BLOCKER=CNPG full E2E failed at line %s\n' "$line"
  [ ! -f "${operator_log:-}" ] || { printf '%s\n' '--- backup-operator.log ---' >&2; cat "$operator_log" >&2; }
  kubectl -n "$namespace" get cluster,backup,pod,pvc,svc -o wide >&2 2>/dev/null || true
}
trap cleanup EXIT
trap 'failure_diagnostics "$LINENO"' ERR

fetch() {
  local url="$1" output="$2"
  curl -fL --retry 1 --retry-delay 2 --connect-timeout 10 --max-time 90 "$url" -o "$output"
}

kind create cluster --name "$cluster" --wait 120s >/dev/null
cluster_created=1
for image in "$minio_image" "$minio_mc_image"; do
  docker image inspect "$image" >/dev/null 2>&1 || docker pull "$image" >/dev/null
  kind load docker-image --name "$cluster" "$image" >/dev/null
done
kind get kubeconfig --name "$cluster" >"$tmp/kubeconfig"
export KUBECONFIG="$tmp/kubeconfig"
fetch "https://github.com/cert-manager/cert-manager/releases/download/v${cert_manager_version}/cert-manager.yaml" "$tmp/cert-manager.yaml"
kubectl apply -f "$tmp/cert-manager.yaml" >/dev/null
if ! kubectl -n cert-manager wait --for=condition=Available deployment --all --timeout=180s >/dev/null; then
  printf 'CAPABILITY_BLOCKER=cert-manager v%s did not become available\n' "$cert_manager_version"
  exit 69
fi

fetch "https://github.com/cloudnative-pg/cloudnative-pg/releases/download/v${cnpg_version}/cnpg-${cnpg_version}.yaml" "$tmp/cnpg.yaml"
kubectl apply --server-side -f "$tmp/cnpg.yaml" >/dev/null
if ! kubectl -n cnpg-system wait --for=condition=Available deployment --all --timeout=180s >/dev/null; then
  printf 'CAPABILITY_BLOCKER=CloudNativePG v%s did not become available\n' "$cnpg_version"
  exit 69
fi

fetch "https://github.com/cloudnative-pg/plugin-barman-cloud/releases/download/v${barman_version}/manifest.yaml" "$tmp/barman.yaml"
kubectl apply --server-side -f "$tmp/barman.yaml" >/dev/null
if ! kubectl wait --for=condition=Available deployment --all --all-namespaces --timeout=180s >/dev/null; then
  printf 'CAPABILITY_BLOCKER=Barman Cloud plugin v%s did not become available\n' "$barman_version"
  exit 69
fi

cluster_crd="$(kubectl get crd clusters.postgresql.cnpg.io -o name 2>/dev/null || true)"
objectstore_crd="$(kubectl get crd objectstores.barmancloud.cnpg.io -o name 2>/dev/null || true)"
if [ -z "$cluster_crd" ] || [ -z "$objectstore_crd" ]; then
  printf 'CAPABILITY_BLOCKER=CNPG or Barman ObjectStore CRD is missing\n'
  exit 69
fi

kubectl create namespace "$namespace" >/dev/null

openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -subj '/CN=minio.cnpg-e2e.svc' \
  -addext 'subjectAltName=DNS:minio,DNS:minio.cnpg-e2e,DNS:minio.cnpg-e2e.svc,DNS:minio.cnpg-e2e.svc.cluster.local' \
  -keyout "$tmp/minio.key" -out "$tmp/minio.crt" >/dev/null 2>&1
kubectl -n "$namespace" create secret generic minio-tls \
  --from-file=public.crt="$tmp/minio.crt" --from-file=private.key="$tmp/minio.key" >/dev/null
kubectl -n "$namespace" create secret generic minio-ca --from-file=ca.crt="$tmp/minio.crt" >/dev/null
kubectl -n "$namespace" create secret generic minio \
  --from-literal=ACCESS_KEY_ID=minioadmin --from-literal=ACCESS_SECRET_KEY=minioadmin123 >/dev/null

kubectl -n "$namespace" apply -f - >/dev/null <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata:
  name: minio
spec:
  replicas: 1
  selector:
    matchLabels:
      app: minio
  template:
    metadata:
      labels:
        app: minio
    spec:
      containers:
        - name: minio
          image: minio/minio:RELEASE.2025-04-22T22-12-26Z
          args: ["server", "/data"]
          env:
            - name: MINIO_ROOT_USER
              valueFrom: {secretKeyRef: {name: minio, key: ACCESS_KEY_ID}}
            - name: MINIO_ROOT_PASSWORD
              valueFrom: {secretKeyRef: {name: minio, key: ACCESS_SECRET_KEY}}
          ports:
            - {name: api, containerPort: 9000}
          readinessProbe:
            tcpSocket: {port: api}
          volumeMounts:
            - {name: data, mountPath: /data}
            - {name: tls, mountPath: /root/.minio/certs, readOnly: true}
      volumes:
        - name: data
          emptyDir: {}
        - name: tls
          secret:
            secretName: minio-tls
---
apiVersion: v1
kind: Service
metadata:
  name: minio
spec:
  selector: {app: minio}
  ports:
    - {name: api, port: 9000, targetPort: api}
YAML
kubectl -n "$namespace" wait --for=condition=Available deployment/minio --timeout=120s >/dev/null

kubectl -n "$namespace" apply -f - >/dev/null <<'YAML'
apiVersion: batch/v1
kind: Job
metadata:
  name: minio-create-bucket
spec:
  backoffLimit: 2
  template:
    spec:
      restartPolicy: Never
      initContainers:
        - name: wait-for-minio-dns
          image: busybox:1.37.0
          command: ["/bin/sh", "-ec"]
          args: ["until nslookup minio.cnpg-e2e.svc.cluster.local; do sleep 2; done"]
      containers:
        - name: mc
          image: minio/mc:RELEASE.2025-04-16T18-13-26Z
          command: ["/bin/sh", "-ec"]
          args: ["mc alias set --insecure e2e https://minio:9000 \"$ACCESS_KEY_ID\" \"$ACCESS_SECRET_KEY\"; mc ready --insecure e2e; mc mb --insecure --ignore-existing e2e/backups; mc stat --insecure e2e/backups"]
          env:
            - name: ACCESS_KEY_ID
              valueFrom: {secretKeyRef: {name: minio, key: ACCESS_KEY_ID}}
            - name: ACCESS_SECRET_KEY
              valueFrom: {secretKeyRef: {name: minio, key: ACCESS_SECRET_KEY}}
YAML
if ! kubectl -n "$namespace" wait --for=condition=Complete job/minio-create-bucket --timeout=120s >/dev/null; then
  kubectl -n "$namespace" get job,pod -o wide >&2 || true
  kubectl -n "$namespace" describe job minio-create-bucket >&2 || true
  kubectl -n "$namespace" logs job/minio-create-bucket --all-containers --prefix >&2 || true
  kubectl -n "$namespace" get events --sort-by=.lastTimestamp >&2 || true
  printf 'CAPABILITY_BLOCKER=minio-create-bucket did not complete; diagnostics emitted above\n'
  exit 69
fi

kubectl -n "$namespace" apply -f - >/dev/null <<'YAML'
apiVersion: barmancloud.cnpg.io/v1
kind: ObjectStore
metadata:
  name: minio-store
  annotations:
    backup.supabase.com/server-name: source
spec:
  configuration:
    destinationPath: s3://backups/
    endpointURL: https://minio.cnpg-e2e.svc.cluster.local:9000
    endpointCA:
      name: minio-ca
      key: ca.crt
    s3Credentials:
      accessKeyId: {name: minio, key: ACCESS_KEY_ID}
      secretAccessKey: {name: minio, key: ACCESS_SECRET_KEY}
    wal:
      compression: gzip
YAML

kubectl -n "$namespace" create secret generic pg-superuser \
  --type=kubernetes.io/basic-auth --from-literal=username=postgres --from-literal=password=cnpg-e2e-password >/dev/null
kubectl -n "$namespace" apply -f - >/dev/null <<YAML
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: source
spec:
  instances: 1
  imageName: ghcr.io/cloudnative-pg/postgresql:17
  enableSuperuserAccess: true
  superuserSecret:
    name: pg-superuser
  plugins:
    - name: barman-cloud.cloudnative-pg.io
      isWALArchiver: true
      parameters:
        barmanObjectName: minio-store
  storage:
    size: 1Gi
YAML
if ! kubectl -n "$namespace" wait --for=condition=Ready cluster/source --timeout=240s >/dev/null; then
  kubectl -n "$namespace" get cluster,pod,pvc -o wide >&2 || true
  printf 'CAPABILITY_BLOCKER=CNPG source Cluster did not become ready\n'
  exit 69
fi

source_uid="$(kubectl -n "$namespace" get cluster source -o jsonpath='{.metadata.uid}')"
source_primary="$(kubectl -n "$namespace" get cluster source -o jsonpath='{.status.currentPrimary}')"
source_pvc_uid="$(kubectl -n "$namespace" get pvc -l cnpg.io/cluster=source -o jsonpath='{.items[0].metadata.uid}')"
kubectl -n "$namespace" exec "$source_primary" -- psql -U postgres -v ON_ERROR_STOP=1 -c \
  "CREATE TABLE recovery_markers(marker text PRIMARY KEY); INSERT INTO recovery_markers VALUES ('before-target');" >/dev/null

kubectl -n "$namespace" apply -f - >/dev/null <<'YAML'
apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata:
  name: source-backup
spec:
  cluster:
    name: source
  method: plugin
  pluginConfiguration:
    name: barman-cloud.cloudnative-pg.io
YAML
backup_phase=""
for _ in $(seq 1 120); do
  backup_phase="$(kubectl -n "$namespace" get backup source-backup -o jsonpath='{.status.phase}' 2>/dev/null || true)"
  case "${backup_phase,,}" in completed) break ;; failed) kubectl -n "$namespace" get backup source-backup -o yaml >&2; exit 1 ;; esac
  sleep 2
done
if [ "${backup_phase,,}" != completed ]; then
  kubectl -n "$namespace" get backup source-backup -o yaml >&2 || true
  printf 'CAPABILITY_BLOCKER=CNPG plugin backup did not complete (phase=%s)\n' "$backup_phase"
  exit 69
fi
backup_id="$(kubectl -n "$namespace" get backup source-backup -o jsonpath='{.status.backupId}')"
[ -n "$backup_id" ] || { printf 'CAPABILITY_BLOCKER=completed CNPG Backup has no status.backupId required for named-target recovery\n'; exit 69; }
backup_completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

recovery_target="$(kubectl -n "$namespace" exec "$source_primary" -- psql -U postgres -Atqc \
  "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"')")"
sleep 1
kubectl -n "$namespace" exec "$source_primary" -- psql -U postgres -Atq -v ON_ERROR_STOP=1 -c \
  "INSERT INTO recovery_markers VALUES ('after-target');" >/dev/null
# The marker transaction must commit before the switch. Combining these SQL
# statements in one psql -c transaction can put COMMIT in the next segment,
# making the returned switched WAL an insufficient coverage boundary.
switched_wal="$(kubectl -n "$namespace" exec "$source_primary" -- psql -U postgres -Atq -v ON_ERROR_STOP=1 -c \
  "SELECT pg_walfile_name(pg_switch_wal());")"
[ -n "$switched_wal" ] || { printf 'CAPABILITY_BLOCKER=pg_switch_wal returned no WAL filename\n'; exit 69; }
archive_ready=""
last_archived_wal=""
for _ in $(seq 1 90); do
  archive_ready="$(kubectl -n "$namespace" get cluster source -o jsonpath='{.status.conditions[?(@.type=="ContinuousArchiving")].status}' 2>/dev/null || true)"
  last_archived_wal="$(kubectl -n "$namespace" exec "$source_primary" -- psql -U postgres -Atq -c \
    "SELECT COALESCE(last_archived_wal, '') FROM pg_stat_archiver" 2>/dev/null || true)"
  if [ "$archive_ready" = True ] && [ -n "$last_archived_wal" ] && [[ "$last_archived_wal" > "$switched_wal" || "$last_archived_wal" = "$switched_wal" ]]; then
    break
  fi
  sleep 2
done
[ "$archive_ready" = True ] || { printf 'CAPABILITY_BLOCKER=CNPG continuous archiving did not become healthy\n'; exit 69; }
if [ -z "$last_archived_wal" ] || [[ "$last_archived_wal" < "$switched_wal" ]]; then
  printf 'CAPABILITY_BLOCKER=CNPG WAL coverage incomplete (switched=%s last_archived=%s)\n' "$switched_wal" "$last_archived_wal"
  exit 69
fi
recoverable_until="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

kubectl -n "$namespace" apply -f - >/dev/null <<'YAML'
apiVersion: batch/v1
kind: Job
metadata:
  name: minio-inspect
spec:
  backoffLimit: 1
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: mc
          image: minio/mc:RELEASE.2025-04-16T18-13-26Z
          command: ["/bin/sh", "-ec"]
          args: ["mc alias set --insecure e2e https://minio:9000 \"$ACCESS_KEY_ID\" \"$ACCESS_SECRET_KEY\" >/dev/null; mc find --insecure e2e/backups"]
          env:
            - name: ACCESS_KEY_ID
              valueFrom: {secretKeyRef: {name: minio, key: ACCESS_KEY_ID}}
            - name: ACCESS_SECRET_KEY
              valueFrom: {secretKeyRef: {name: minio, key: ACCESS_SECRET_KEY}}
YAML
kubectl -n "$namespace" wait --for=condition=Complete job/minio-inspect --timeout=120s >/dev/null
object_listing="$(kubectl -n "$namespace" logs job/minio-inspect)"
printf '%s\n' "$object_listing" | grep -q '/base/'
printf '%s\n' "$object_listing" | grep -q '/wals/'
object_count="$(printf '%s\n' "$object_listing" | grep -c . | tr -d ' ')"

kubectl -n "$namespace" apply -f - >/dev/null <<'YAML'
apiVersion: barmancloud.cnpg.io/v1
kind: ObjectStore
metadata:
  name: restore-output
spec:
  configuration:
    destinationPath: s3://backups/
    endpointURL: https://minio.cnpg-e2e.svc.cluster.local:9000
    endpointCA: {name: minio-ca, key: ca.crt}
    s3Credentials:
      accessKeyId: {name: minio, key: ACCESS_KEY_ID}
      secretAccessKey: {name: minio, key: ACCESS_SECRET_KEY}
---
apiVersion: v1
kind: Service
metadata:
  name: database-stable
spec:
  selector:
    cnpg.io/cluster: source
    role: primary
  ports:
    - {name: postgres, port: 5432, targetPort: 5432}
YAML
wait_stable_endpoint() {
  local expected="$1" actual=""
  for _ in $(seq 1 30); do
    actual="$(kubectl -n "$namespace" get endpointslice -l kubernetes.io/service-name=database-stable -o jsonpath='{.items[0].endpoints[0].targetRef.name}' 2>/dev/null || true)"
    [ "$actual" = "$expected" ] && return 0
    sleep 1
  done
  printf 'CAPABILITY_BLOCKER=database-stable EndpointSlice did not switch to %s (actual=%s)\n' "$expected" "$actual"
  return 1
}
query_stable_count() {
  local expected="$1" actual=""
  for _ in $(seq 1 30); do
    actual="$(kubectl -n "$namespace" exec "$source_primary" -- env PGPASSWORD=cnpg-e2e-password PGCONNECT_TIMEOUT=3 \
      psql -h database-stable -U postgres -Atqc 'SELECT count(*) FROM recovery_markers' 2>/dev/null || true)"
    if [ "$actual" = "$expected" ]; then printf '%s\n' "$actual"; return 0; fi
    sleep 1
  done
  printf 'CAPABILITY_BLOCKER=database-stable SQL did not converge to %s (actual=%s)\n' "$expected" "$actual" >&2
  return 1
}
wait_stable_endpoint "$source_primary"
source_via_service="$(query_stable_count 2)"
[ "$source_via_service" = 2 ]

# Persist the normalized observation produced by the real CNPG Backup/WAL
# setup, then start the production binary. No restore resource below is
# created by this harness: API dispatch and the TaskRouter strategy own it.
source_system_id="$(kubectl -n "$namespace" get cluster source -o jsonpath='{.status.systemID}')"
control_db="$tmp/control.db"
(cd "$(dirname "$0")/../.." && go run ./test/e2e/seed-observation \
  --dsn "$control_db" --project cnpg-e2e --target cnpg-database \
  --system-id "$source_system_id" --repository minio-store --backup-id "$backup_id" \
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
project_id='cnpg-e2e'
target_id='cnpg-database'
# shellcheck source=lib/product-chain.sh
source "$(dirname "$0")/lib/product-chain.sh"
"$operator_bin" --mode all --listen "127.0.0.1:$operator_port" \
  --control-store-dsn "$control_db" --service-assertion-key "$assertion_key" \
  --runtime-enable --runtime-poll-interval 200ms --runtime-lease-ttl 2s \
  --cloudnativepg-enable --cloudnativepg-kubeconfig "$tmp/kubeconfig" \
  --cloudnativepg-namespace "$namespace" --cloudnativepg-project "$project_id" \
  --cloudnativepg-target "$target_id" --cloudnativepg-cluster source \
  --cloudnativepg-image ghcr.io/cloudnative-pg/postgresql:17 \
  --cloudnativepg-stable-service database-stable --cloudnativepg-output-object-store restore-output \
  --cloudnativepg-output-server-name "restore-$cluster" --cloudnativepg-storage-size 1Gi \
  --cloudnativepg-registry-url "http://127.0.0.1:$control_port/registry" \
  --cloudnativepg-validator-url "http://127.0.0.1:$control_port/validate" \
  --cloudnativepg-fencer-url "http://127.0.0.1:$control_port/fence" \
  --cloudnativepg-required-bytes 1073741824 --cloudnativepg-available-bytes 2147483648 \
  >"$operator_log" 2>&1 &
operator_pid=$!
wait_operator_ready
capabilities="$(operator_request GET /v1/capabilities)"
jq -e '.[] | select(.name=="cloudnativepg-cnpg-i") | .supported == true' <<<"$capabilities" >/dev/null || {
  printf 'CloudNativePG capability is blocked: %s\n' "$capabilities" >&2
  false
}
jq -e '.[] | select(.name=="destructive-restore") | .supported == true' <<<"$capabilities" >/dev/null || {
  printf 'destructive restore capability is blocked: %s\n' "$capabilities" >&2
  false
}
operator_request POST /v1/clusters \
  "$(jq -cn --arg project "$project_id" --arg target "$target_id" --arg system "$source_system_id" \
    '{projectId:$project,targetId:$target,systemIdentifier:$system,dataDomain:"cnpg-pgdata"}')" >/dev/null
execute_restore_through_product "$recovery_target"

replacement="$(kubectl -n "$namespace" get cluster -l "backup.supabase.com/recovery-plan=$plan_id" -o jsonpath='{.items[0].metadata.name}')"
[ -n "$replacement" ]
replacement_primary="$(kubectl -n "$namespace" get cluster "$replacement" -o jsonpath='{.status.currentPrimary}')"
replacement_uid="$(kubectl -n "$namespace" get cluster "$replacement" -o jsonpath='{.metadata.uid}')"
replacement_pvc_uid="$(kubectl -n "$namespace" get pvc -l "cnpg.io/cluster=$replacement" -o jsonpath='{.items[0].metadata.uid}')"
replacement_markers="$(kubectl -n "$namespace" exec "$replacement_primary" -- psql -U postgres -Atqc 'SELECT string_agg(marker, '\''|'\'' ORDER BY marker) FROM recovery_markers')"
[ "$replacement_markers" = before-target ]
[ "$source_pvc_uid" != "$replacement_pvc_uid" ]
wait_stable_endpoint "$replacement_primary"
replacement_via_service="$(query_stable_count 1)"
[ "$replacement_via_service" = 1 ]
rollback_restore_through_product
wait_stable_endpoint "$source_primary"
rollback_via_service="$(query_stable_count 2)"
[ "$rollback_via_service" = 2 ]

printf 'cnpg_version=%s\ncert_manager_version=%s\nbarman_plugin_version=%s\n' "$cnpg_version" "$cert_manager_version" "$barman_version"
printf 'source_cluster_uid=%s\nsource_primary=%s\nsource_pvc_uid=%s\n' "$source_uid" "$source_primary" "$source_pvc_uid"
printf 'backup_phase=%s\nbackup_id=%s\nobject_count=%s\nwal_archiving=%s\nswitched_wal=%s\nlast_archived_wal=%s\nrecovery_target=%s\n' "$backup_phase" "$backup_id" "$object_count" "$archive_ready" "$switched_wal" "$last_archived_wal" "$recovery_target"
printf 'replacement_cluster_uid=%s\nreplacement_primary=%s\nreplacement_pvc_uid=%s\nreplacement_markers=%s\n' "$replacement_uid" "$replacement_primary" "$replacement_pvc_uid" "$replacement_markers"
printf 'operator_plan_id=%s\noperator_job_id=%s\nproduct_chain=api-controlstore-outbox-taskrouter-cnpg\n' "$plan_id" "$job_id"
printf 'cutover_source_count=%s\ncutover_replacement_count=%s\nrollback_source_count=%s\nRESULT=PASS\n' "$source_via_service" "$replacement_via_service" "$rollback_via_service"
