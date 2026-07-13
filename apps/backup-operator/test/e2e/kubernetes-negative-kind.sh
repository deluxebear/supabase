#!/usr/bin/env bash
set -Eeuo pipefail

# IFN-48/51: real Kubernetes negative contracts for replacement recovery.
cluster="backup-negative-$$"
namespace="backup-negative"
proxy_port=$((18000 + $$ % 10000))
proxy_pid=""
tmp="$(mktemp -d)"

cleanup() {
  if [ -n "$proxy_pid" ]; then kill "$proxy_pid" >/dev/null 2>&1 || true; fi
  kind delete cluster --name "$cluster" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT
trap 'printf "NEGATIVE_FAILURE_LINE=%s\n" "$LINENO" >&2' ERR

cat >"$tmp/kind.yaml" <<'EOF'
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
nodes:
  - role: control-plane
  - role: worker
  - role: worker
EOF
kind create cluster --name "$cluster" --config "$tmp/kind.yaml" --wait 120s >/dev/null
kubectl create namespace "$namespace" >/dev/null

# Capacity: a real PVC cannot bind when its request exceeds every matching PV.
kubectl apply -f - >/dev/null <<YAML
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata: {name: backup-static-capacity}
provisioner: kubernetes.io/no-provisioner
volumeBindingMode: Immediate
---
apiVersion: v1
kind: PersistentVolume
metadata: {name: ${cluster}-small}
spec:
  capacity: {storage: 1Mi}
  accessModes: [ReadWriteOnce]
  persistentVolumeReclaimPolicy: Delete
  storageClassName: backup-static-capacity
  hostPath: {path: /tmp/${cluster}-small}
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: {name: restore-too-large, namespace: ${namespace}}
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: backup-static-capacity
  resources: {requests: {storage: 2Mi}}
YAML
capacity_reason=""
for _ in $(seq 1 5); do
  test "$(kubectl -n "$namespace" get pvc restore-too-large -o jsonpath='{.status.phase}')" = Pending
  capacity_reason="$(kubectl -n "$namespace" get events --field-selector involvedObject.name=restore-too-large -o jsonpath='{range .items[*]}{.reason}:{.message}{"\\n"}{end}')"
  if printf '%s' "$capacity_reason" | grep -Eqi 'FailedBinding|no persistent volumes available|storage class'; then break; fi
  sleep 1
done
test "$(kubectl get pv "${cluster}-small" -o jsonpath='{.spec.capacity.storage}')" = 1Mi
test "$(kubectl -n "$namespace" get pvc restore-too-large -o jsonpath='{.spec.resources.requests.storage}')" = 2Mi

# RWO/node affinity: bind one static RWO volume to worker-1, then prove a pod
# pinned to worker-2 cannot mount it. This avoids incorrectly treating RWO as
# single-pod access on one node.
worker_one="${cluster}-worker"
worker_two="${cluster}-worker2"
kubectl apply -f - >/dev/null <<YAML
apiVersion: v1
kind: PersistentVolume
metadata: {name: ${cluster}-rwo}
spec:
  capacity: {storage: 8Mi}
  accessModes: [ReadWriteOnce]
  persistentVolumeReclaimPolicy: Delete
  storageClassName: backup-static-rwo
  claimRef: {namespace: ${namespace}, name: restore-rwo}
  hostPath: {path: /tmp/${cluster}-rwo}
  nodeAffinity:
    required:
      nodeSelectorTerms:
        - matchExpressions:
            - {key: kubernetes.io/hostname, operator: In, values: [${worker_one}]}
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: {name: restore-rwo, namespace: ${namespace}}
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: backup-static-rwo
  volumeName: ${cluster}-rwo
  resources: {requests: {storage: 8Mi}}
---
apiVersion: v1
kind: Pod
metadata: {name: rwo-owner, namespace: ${namespace}}
spec:
  nodeName: ${worker_one}
  containers:
    - name: hold
      image: registry.k8s.io/pause:3.10
      volumeMounts: [{name: data, mountPath: /data}]
  volumes: [{name: data, persistentVolumeClaim: {claimName: restore-rwo}}]
---
apiVersion: v1
kind: Pod
metadata: {name: rwo-conflict, namespace: ${namespace}}
spec:
  nodeSelector: {kubernetes.io/hostname: ${worker_two}}
  containers:
    - name: hold
      image: registry.k8s.io/pause:3.10
      volumeMounts: [{name: data, mountPath: /data}]
  volumes: [{name: data, persistentVolumeClaim: {claimName: restore-rwo}}]
YAML
kubectl -n "$namespace" wait --for=condition=Ready pod/rwo-owner --timeout=120s >/dev/null
sleep 3
test "$(kubectl -n "$namespace" get pod rwo-conflict -o jsonpath='{.status.phase}')" = Pending
rwo_reason="$(kubectl -n "$namespace" get pod rwo-conflict -o jsonpath='{range .status.conditions[*]}{.reason}:{.message}{"\\n"}{end}')"
printf '%s' "$rwo_reason" | grep -Eqi 'node affinity|volume node affinity conflict'

# Optimistic API conflict: retain a stale resourceVersion, advance the live
# object, and prove replacement with the stale object is rejected (HTTP 409).
kubectl -n "$namespace" create configmap recovery-owner --from-literal=owner=operator-a >/dev/null
kubectl -n "$namespace" get configmap recovery-owner -o json >"$tmp/stale.json"
kubectl -n "$namespace" patch configmap recovery-owner --type=merge -p '{"data":{"owner":"operator-b"}}' >/dev/null
if kubectl replace -f "$tmp/stale.json" >"$tmp/conflict.out" 2>"$tmp/conflict.err"; then
  printf 'stale resourceVersion unexpectedly replaced the live object\n' >&2
  exit 1
fi
grep -Eqi 'modified|Conflict|object has been modified' "$tmp/conflict.err"

# Cutover response loss: kubectl proxy authenticates the real API request.
# curl accepts only a one-byte response, so it aborts after the API server has
# committed the Service patch but before the client receives the response body.
kubectl -n "$namespace" create service clusterip pitr-route --tcp=5432:5432 >/dev/null
kubectl -n "$namespace" patch service pitr-route --type=merge -p '{"spec":{"selector":{"app":"source"}}}' >/dev/null
kubectl proxy --address=127.0.0.1 --accept-hosts='^127\.0\.0\.1$' --port="$proxy_port" >"$tmp/proxy.log" 2>&1 &
proxy_pid=$!
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${proxy_port}/version" >/dev/null 2>&1; then break; fi
  sleep 1
done
patch='{"spec":{"selector":{"app":"recovered"}}}'
if curl -sS --max-filesize 1 -o "$tmp/cutover-response" \
  -X PATCH -H 'Content-Type: application/strategic-merge-patch+json' --data "$patch" \
  "http://127.0.0.1:${proxy_port}/api/v1/namespaces/${namespace}/services/pitr-route"; then
  printf 'cutover client unexpectedly received the complete response\n' >&2
  exit 1
fi
test "$(kubectl -n "$namespace" get service pitr-route -o jsonpath='{.spec.selector.app}')" = recovered

node_image="$(docker inspect "${cluster}-control-plane" --format '{{.Image}}')"
printf 'capacity_pending=true\n'
printf 'rwo_cross_node_blocked=true\n'
printf 'api_conflict_rejected=true\n'
printf 'cutover_response_lost_but_committed=true\n'
printf 'kind_node_image=%s\n' "$node_image"
printf 'kubernetes_version=%s\n' "$(kubectl version -o json | jq -r .serverVersion.gitVersion)"
printf 'RESULT=PASS\n'
