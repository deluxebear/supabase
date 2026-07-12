#!/usr/bin/env bash
set -euo pipefail

# Destructive M0 spike. It creates one uniquely named Kind cluster and accepts
# no caller-controlled SQL, Kubernetes resource names, credentials, or paths.
# The optional variant is resolved through a closed image allowlist.
cluster="supabase-pitr-spike-$$"
namespace="pitr-spike"
password="supabase-spike-only"
variant="${1:-pg17}"

case "$variant" in
  pg17) image="deluxebear/postgres:17" ;;
  orioledb17) image="deluxebear/postgres:orioledb-17" ;;
  *) printf 'unsupported variant: %s\n' "$variant" >&2; exit 64 ;;
esac

if ! pgbackrest_version="$(docker run --rm --entrypoint sh "$image" -c \
  '/usr/lib/pgbackrest/bin/pgbackrest.real version' 2>/dev/null)"; then
  printf 'CAPABILITY_BLOCKER=image %s does not contain the managed pgBackRest binary\n' "$image" >&2
  exit 65
fi

cleanup() {
  kind delete cluster --name "$cluster" >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_pod() {
  local selector="$1"
  kubectl -n "$namespace" wait --for=condition=Ready pod \
    -l "$selector" --timeout=240s >/dev/null
}

query_service() {
  local service="$1"
  local expected="$2"
  local result
  for _ in $(seq 1 60); do
    if result="$(kubectl -n "$namespace" exec source-0 -- env PGPASSWORD="$password" \
      psql -h "$service" -U postgres -d postgres -Atqc \
      "select string_agg(value, ',' order by id) from recovery_markers" 2>/dev/null)"; then
      if [ "$result" = "$expected" ]; then
        printf '%s\n' "$result"
        return 0
      fi
    fi
    sleep 1
  done
  kubectl -n "$namespace" get service "$service" -o wide >&2
  kubectl -n "$namespace" get endpoints "$service" -o yaml >&2
  return 1
}

kind create cluster --name "$cluster" --wait 120s >/dev/null
kind load docker-image --name "$cluster" "$image" >/dev/null
kubectl create namespace "$namespace" >/dev/null

kubectl -n "$namespace" create secret generic postgres-password \
  --from-literal="password=$password" >/dev/null

kubectl -n "$namespace" apply -f - >/dev/null <<YAML
apiVersion: v1
kind: ConfigMap
metadata:
  name: pgbackrest-spike
data:
  spike.conf: |
    [global]
    repo1-path=/var/lib/pgbackrest/repo
    repo1-retention-full=2
    repo1-type=posix

    [k8s-spike]
    pg1-path=/var/lib/postgresql/data
    pg1-socket-path=/var/run/postgresql
    pg1-user=postgres
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: backup-repository
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests: {storage: 2Gi}
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: source-data
  labels: {app: source}
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests: {storage: 2Gi}
---
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: source
spec:
  serviceName: source-headless
  replicas: 1
  selector:
    matchLabels: {app: source}
  template:
    metadata:
      labels: {app: source}
    spec:
      initContainers:
        - name: repository-permissions
          image: ${image}
          imagePullPolicy: Never
          command: [sh, -c, "chown -R postgres:postgres /var/lib/pgbackrest/repo"]
          volumeMounts:
            - {name: repository, mountPath: /var/lib/pgbackrest/repo}
      containers:
        - name: postgres
          image: ${image}
          imagePullPolicy: Never
          args:
            - postgres
            - -c
            - config_file=/etc/postgresql/postgresql.conf
            - -c
            - archive_mode=on
            - -c
            - archive_command=/usr/lib/pgbackrest/bin/pgbackrest.real --stanza=k8s-spike archive-push %p
          env:
            - {name: POSTGRES_DB, value: postgres}
            - {name: POSTGRES_USER, value: postgres}
            - name: POSTGRES_PASSWORD
              valueFrom: {secretKeyRef: {name: postgres-password, key: password}}
          ports:
            - {name: postgres, containerPort: 5432}
          readinessProbe:
            exec: {command: [pg_isready, -U, postgres]}
            periodSeconds: 2
          volumeMounts:
            - {name: data, mountPath: /var/lib/postgresql/data}
            - {name: repository, mountPath: /var/lib/pgbackrest/repo}
            - {name: config, mountPath: /etc/pgbackrest/conf.d/spike.conf, subPath: spike.conf, readOnly: true}
      volumes:
        - {name: data, persistentVolumeClaim: {claimName: source-data}}
        - {name: repository, persistentVolumeClaim: {claimName: backup-repository}}
        - {name: config, configMap: {name: pgbackrest-spike}}
---
apiVersion: v1
kind: Service
metadata:
  name: source-headless
spec:
  clusterIP: None
  selector: {app: source}
  ports:
    - {name: postgres, port: 5432, targetPort: postgres}
---
apiVersion: v1
kind: Service
metadata:
  name: pitr-route
spec:
  selector: {app: source}
  ports:
    - {name: postgres, port: 5432, targetPort: postgres}
YAML

wait_pod app=source

if [ "$variant" = "orioledb17" ]; then
  kubectl -n "$namespace" exec source-0 -- psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c \
    "create role supabase_admin superuser; create extension if not exists orioledb cascade;" >/dev/null
fi

kubectl -n "$namespace" exec source-0 -- \
  su-exec postgres /usr/lib/pgbackrest/bin/pgbackrest.real --stanza=k8s-spike stanza-create >/dev/null
kubectl -n "$namespace" exec source-0 -- \
  su-exec postgres /usr/lib/pgbackrest/bin/pgbackrest.real --stanza=k8s-spike check >/dev/null
kubectl -n "$namespace" exec source-0 -- psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c \
  "create table recovery_markers(id bigint primary key, value text not null); insert into recovery_markers values (1, 'before-target');" >/dev/null
kubectl -n "$namespace" exec source-0 -- \
  su-exec postgres /usr/lib/pgbackrest/bin/pgbackrest.real --stanza=k8s-spike --type=full backup >/dev/null
kubectl -n "$namespace" exec source-0 -- psql -v ON_ERROR_STOP=1 -U postgres -d postgres -c \
  "select pg_create_restore_point('k8s_spike_target'); insert into recovery_markers values (2, 'after-target'); select pg_switch_wal();" >/dev/null
kubectl -n "$namespace" exec source-0 -- \
  su-exec postgres /usr/lib/pgbackrest/bin/pgbackrest.real --stanza=k8s-spike check >/dev/null

source_pvc_uid="$(kubectl -n "$namespace" get pvc source-data -o jsonpath='{.metadata.uid}')"
source_pv_name="$(kubectl -n "$namespace" get pvc source-data -o jsonpath='{.spec.volumeName}')"
source_pod_uid="$(kubectl -n "$namespace" get pod source-0 -o jsonpath='{.metadata.uid}')"
source_system_id="$(kubectl -n "$namespace" exec source-0 -- pg_controldata /var/lib/postgresql/data | awk -F: '/Database system identifier/{gsub(/ /,"",$2); print $2}')"
before_route="$(query_service pitr-route before-target,after-target)"
test "$before_route" = "before-target,after-target"

kubectl -n "$namespace" apply -f - >/dev/null <<YAML
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: recovered-data
  labels: {app: recovered}
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests: {storage: 2Gi}
---
apiVersion: batch/v1
kind: Job
metadata:
  name: restore-replacement
spec:
  backoffLimit: 0
  template:
    spec:
      restartPolicy: Never
      containers:
        - name: restore
          image: ${image}
          imagePullPolicy: Never
          command:
            - sh
            - -c
            - >-
              chown -R postgres:postgres /var/lib/postgresql/data &&
              su-exec postgres /usr/lib/pgbackrest/bin/pgbackrest.real
              --stanza=k8s-spike --type=name --target=k8s_spike_target
              --target-action=promote restore
          volumeMounts:
            - {name: data, mountPath: /var/lib/postgresql/data}
            - {name: repository, mountPath: /var/lib/pgbackrest/repo, readOnly: true}
            - {name: config, mountPath: /etc/pgbackrest/conf.d/spike.conf, subPath: spike.conf, readOnly: true}
      volumes:
        - {name: data, persistentVolumeClaim: {claimName: recovered-data}}
        - {name: repository, persistentVolumeClaim: {claimName: backup-repository}}
        - {name: config, configMap: {name: pgbackrest-spike}}
YAML
kubectl -n "$namespace" wait --for=condition=Complete job/restore-replacement --timeout=240s >/dev/null

kubectl -n "$namespace" apply -f - >/dev/null <<YAML
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: recovered
spec:
  serviceName: recovered-headless
  replicas: 1
  selector:
    matchLabels: {app: recovered}
  template:
    metadata:
      labels: {app: recovered}
    spec:
      containers:
        - name: postgres
          image: ${image}
          imagePullPolicy: Never
          args:
            - postgres
            - -c
            - config_file=/etc/postgresql/postgresql.conf
            - -c
            - archive_mode=off
          env:
            - {name: POSTGRES_DB, value: postgres}
            - {name: POSTGRES_USER, value: postgres}
            - name: POSTGRES_PASSWORD
              valueFrom: {secretKeyRef: {name: postgres-password, key: password}}
          ports:
            - {name: postgres, containerPort: 5432}
          readinessProbe:
            exec: {command: [pg_isready, -U, postgres]}
            periodSeconds: 2
          volumeMounts:
            - {name: data, mountPath: /var/lib/postgresql/data}
            - {name: repository, mountPath: /var/lib/pgbackrest/repo, readOnly: true}
            - {name: config, mountPath: /etc/pgbackrest/conf.d/spike.conf, subPath: spike.conf, readOnly: true}
      volumes:
        - {name: data, persistentVolumeClaim: {claimName: recovered-data}}
        - {name: repository, persistentVolumeClaim: {claimName: backup-repository}}
        - {name: config, configMap: {name: pgbackrest-spike}}
---
apiVersion: v1
kind: Service
metadata:
  name: recovered-headless
spec:
  clusterIP: None
  selector: {app: recovered}
  ports:
    - {name: postgres, port: 5432, targetPort: postgres}
---
apiVersion: v1
kind: Service
metadata:
  name: recovered-isolated
spec:
  selector: {app: recovered}
  ports:
    - {name: postgres, port: 5432, targetPort: postgres}
YAML

wait_pod app=recovered
isolated_result="$(query_service recovered-isolated before-target)"
recovered_pvc_uid="$(kubectl -n "$namespace" get pvc recovered-data -o jsonpath='{.metadata.uid}')"
recovered_system_id="$(kubectl -n "$namespace" exec recovered-0 -- pg_controldata /var/lib/postgresql/data | awk -F: '/Database system identifier/{gsub(/ /,"",$2); print $2}')"
test "$isolated_result" = "before-target"
test "$recovered_pvc_uid" != "$source_pvc_uid"
test "$recovered_system_id" = "$source_system_id"

kubectl -n "$namespace" patch service pitr-route --type=merge \
  -p '{"spec":{"selector":{"app":"recovered"}}}' >/dev/null
cutover_result="$(query_service pitr-route before-target)"
test "$cutover_result" = "before-target"

kubectl -n "$namespace" patch service pitr-route --type=merge \
  -p '{"spec":{"selector":{"app":"source"}}}' >/dev/null
rollback_result="$(query_service pitr-route before-target,after-target)"
test "$rollback_result" = "before-target,after-target"

test "$(kubectl -n "$namespace" get pvc source-data -o jsonpath='{.metadata.uid}')" = "$source_pvc_uid"
test "$(kubectl -n "$namespace" get pvc source-data -o jsonpath='{.spec.volumeName}')" = "$source_pv_name"
test "$(kubectl -n "$namespace" get pod source-0 -o jsonpath='{.metadata.uid}')" = "$source_pod_uid"

printf 'variant=%s\n' "$variant"
printf 'provider=custom-image-%s\n' "${pgbackrest_version// /-}"
printf 'source_pvc_uid=%s\n' "$source_pvc_uid"
printf 'recovered_pvc_uid=%s\n' "$recovered_pvc_uid"
printf 'source_pod_uid_unchanged=%s\n' "$source_pod_uid"
printf 'system_identifier=%s\n' "$source_system_id"
printf 'isolated_validation=%s\n' "$isolated_result"
printf 'cutover_validation=%s\n' "$cutover_result"
printf 'rollback_validation=%s\n' "$rollback_result"
printf 'RESULT=PASS\n'
