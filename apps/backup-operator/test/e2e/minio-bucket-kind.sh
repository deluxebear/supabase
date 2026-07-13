#!/usr/bin/env bash
set -Eeuo pipefail

cluster="minio-bucket-smoke-$$"
namespace="minio-smoke"
tmp="$(mktemp -d)"
cleanup() { kind delete cluster --name "$cluster" >/dev/null 2>&1 || true; rm -rf "$tmp"; }
trap cleanup EXIT

kind create cluster --name "$cluster" --wait 120s >/dev/null
kubectl create namespace "$namespace" >/dev/null
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=minio.minio-smoke.svc' \
  -addext 'subjectAltName=DNS:minio,DNS:minio.minio-smoke,DNS:minio.minio-smoke.svc,DNS:minio.minio-smoke.svc.cluster.local' \
  -keyout "$tmp/minio.key" -out "$tmp/minio.crt" >/dev/null 2>&1
kubectl -n "$namespace" create secret generic minio-tls \
  --from-file=public.crt="$tmp/minio.crt" --from-file=private.key="$tmp/minio.key" >/dev/null
kubectl -n "$namespace" create secret generic minio \
  --from-literal=ACCESS_KEY_ID=minioadmin --from-literal=ACCESS_SECRET_KEY=minioadmin123 >/dev/null
kubectl -n "$namespace" apply -f - >/dev/null <<'YAML'
apiVersion: apps/v1
kind: Deployment
metadata: {name: minio}
spec:
  replicas: 1
  selector: {matchLabels: {app: minio}}
  template:
    metadata: {labels: {app: minio}}
    spec:
      containers:
        - name: minio
          image: minio/minio:RELEASE.2025-04-22T22-12-26Z
          args: ["server", "/data"]
          env:
            - {name: MINIO_ROOT_USER, valueFrom: {secretKeyRef: {name: minio, key: ACCESS_KEY_ID}}}
            - {name: MINIO_ROOT_PASSWORD, valueFrom: {secretKeyRef: {name: minio, key: ACCESS_SECRET_KEY}}}
          ports: [{name: api, containerPort: 9000}]
          readinessProbe: {tcpSocket: {port: api}}
          volumeMounts:
            - {name: data, mountPath: /data}
            - {name: tls, mountPath: /root/.minio/certs, readOnly: true}
      volumes:
        - {name: data, emptyDir: {}}
        - {name: tls, secret: {secretName: minio-tls}}
---
apiVersion: v1
kind: Service
metadata: {name: minio}
spec:
  selector: {app: minio}
  ports: [{name: api, port: 9000, targetPort: api}]
---
apiVersion: batch/v1
kind: Job
metadata: {name: minio-create-bucket}
spec:
  backoffLimit: 2
  template:
    spec:
      restartPolicy: Never
      initContainers:
        - name: wait-for-minio-dns
          image: busybox:1.37.0
          command: ["/bin/sh", "-ec"]
          args: ["until nslookup minio.minio-smoke.svc.cluster.local; do sleep 2; done"]
      containers:
        - name: mc
          image: minio/mc:RELEASE.2025-04-16T18-13-26Z
          command: ["/bin/sh", "-ec"]
          args: ["mc alias set --insecure e2e https://minio:9000 \"$ACCESS_KEY_ID\" \"$ACCESS_SECRET_KEY\"; mc ready --insecure e2e; mc mb --insecure --ignore-existing e2e/backups; mc stat --insecure e2e/backups"]
          env:
            - {name: ACCESS_KEY_ID, valueFrom: {secretKeyRef: {name: minio, key: ACCESS_KEY_ID}}}
            - {name: ACCESS_SECRET_KEY, valueFrom: {secretKeyRef: {name: minio, key: ACCESS_SECRET_KEY}}}
YAML
if ! kubectl -n "$namespace" wait --for=condition=Available deployment/minio --timeout=120s >/dev/null || \
   ! kubectl -n "$namespace" wait --for=condition=Complete job/minio-create-bucket --timeout=120s >/dev/null; then
  kubectl -n "$namespace" get deployment,job,pod -o wide >&2 || true
  kubectl -n "$namespace" describe job minio-create-bucket >&2 || true
  kubectl -n "$namespace" logs job/minio-create-bucket --all-containers --prefix >&2 || true
  kubectl -n "$namespace" get events --sort-by=.lastTimestamp >&2 || true
  exit 1
fi
kubectl -n "$namespace" logs job/minio-create-bucket --all-containers --prefix
printf 'minio_bucket_smoke=PASS\n'
