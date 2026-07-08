# Single-project Supabase on Kubernetes

A faithful port of this repo's `docker/docker-compose.yml` to Kubernetes, using the
fork Postgres image `deluxebear/postgres:17`, plus a **cAdvisor DaemonSet** that
exposes per-container `container_*` metrics for the management-plane's k8s metrics
dialect.

> **Verified live** on single-node **k3s v1.36.2** (`ubuntu24vm`, Ubuntu 24.04,
> containerd 2.3.2, amd64) on 2026-07-08 — all 11 Supabase services + cAdvisor
> healthy, kong gateway reachable, end-to-end smoke tests passing.

## What gets deployed

| Manifest | Workloads |
| --- | --- |
| `00-namespace.yaml` | namespace `supabase` |
| `03-db.yaml` | `db` StatefulSet (fork image, PVC, init SQL via subPath) + headless Service `db` |
| `04-cadvisor.yaml` | cAdvisor DaemonSet (k3s/containerd) + Service `cadvisor` |
| `11-core.yaml` | `meta`, `rest`, `auth` (+ Services) |
| `12-storage.yaml` | `imgproxy`, `storage` (+ shared PVC) |
| `13-realtime.yaml` | `realtime` |
| `15-kong.yaml` | `kong` gateway (LoadBalancer :8000/:8443) |
| `18-studio.yaml` | `studio` dashboard |
| `19-functions.yaml` | `functions` edge-runtime |
| `20-supavisor.yaml` | `supavisor` pooler (:4000/:5432/:6543) |

Secrets and file-backed config are **not** committed — `deploy.sh` builds them at
apply time from `docker/.env` and `docker/volumes/**`:

- Secret `supabase-env` ← `docker/.env` (consumed via `secretKeyRef`, so no secret
  is ever written into a committed manifest).
- ConfigMaps `db-init`, `kong-config`, `functions-main`, `pooler-config` ← repo files.

## Deploy

```bash
# from a machine whose kube-context points at the target cluster:
cd docker/k8s/single-project
./deploy.sh
```

Prerequisites: `kubectl` reachable to the cluster; a default StorageClass (k3s ships
`local-path`); `docker/.env` present (copy from `docker/.env.example` and fill in).

## Verify

```bash
kubectl -n supabase get pods                       # all 1/1
GW=http://<node-ip>:8000                            # kong LoadBalancer external IP
ANON=$(grep ^ANON_KEY= ../../.env | cut -d= -f2-)
curl -s "$GW/auth/v1/health"  -H "apikey: $ANON"    # {"version":...,"name":"GoTrue"}
curl -s "$GW/storage/v1/status" -o /dev/null -w '%{http_code}\n'   # 200
kubectl -n supabase exec supabase-db-0 -c postgres -- psql -U postgres -tAc 'select 1'
```

Note: `GET /rest/v1/` (OpenAPI root) is **admin-only** in `kong.yml` → an anon key
returns `403 "You cannot consume this service"`. That is expected; anon reaches data
via `/rest/v1/<table>`.

## compose → k8s gotchas (each cost real debugging)

1. **`command:` vs `args:`** — compose `command:` maps to k8s **`args:`** for images
   with an `ENTRYPOINT` (edge-runtime is `ENTRYPOINT [edge-runtime]`). Using k8s
   `command:` overrides the entrypoint → `"start": not found` crashloop. kong/supavisor
   deliberately DO override (their compose used `entrypoint:`/a shell `command`).
2. **ConfigMap files are symlinks** (`index.ts → ..data/index.ts`). edge-runtime copies
   its main-service dir to a temp compile path and does not follow the symlink →
   `Module not found`. Mount single files via **`subPath`** (real file). Same technique
   places the db init SQL into the two `initdb.d` subdirs **without clobbering** the
   image's 53 baked migrations (a whole-dir ConfigMap mount would hide them).
3. **cAdvisor + read-only `/var/run`** — the SA-token projection mounts under
   `/var/run/secrets`; with `/var/run` mounted read-only that `mkdirat` fails →
   `RunContainerError`. Fix: `automountServiceAccountToken: false` (cAdvisor never
   calls the API). Also point `--containerd` at the k3s socket
   `/run/k3s/containerd/containerd.sock`.
4. **Named-volume auto-population doesn't exist in k8s** — compose copies image content
   into a fresh named volume; an empty PVC does not. The db's `/etc/postgresql-custom`
   ships image content, so this deployment does **not** mount a PVC there (uses the
   image's baked config; the runtime pgsodium key is not persisted across pod
   replacement — see Follow-ups).
5. **`$(VAR)` interpolation** in `env`/`args` only resolves vars declared earlier in the
   same container's `env:` list (not `envFrom`). Composed DSNs therefore declare
   `POSTGRES_*` inline before referencing them.

## Follow-ups (not blocking a working stack)

- Persist the db's pgsodium key: add a `db-config` PVC + an initContainer that
  copies the image's `/etc/postgresql-custom` into it on first boot.
- `analytics` (Logflare) is not deployed here (it lives in `docker-compose.logs.yml`);
  kong routes to `analytics:4000` 503 at request time until it is added.
- External access currently via kong LoadBalancer only; add an Ingress if TLS/hostnames
  are wanted.
- `studio` uses the upstream image per compose; swap to the fork's custom Studio image
  if the self-platform features are wanted on this project's own dashboard.

## cAdvisor metrics (why this exists)

The DaemonSet re-exposes `container_*` + `machine_*`. On k3s/containerd the project's
Postgres identity is:

```
container_label_io_kubernetes_pod_namespace="supabase"
container_label_io_kubernetes_pod_name="supabase-db-0"
container_label_io_kubernetes_container_name="postgres"
```

CPU/memory are on the `postgres` container; **network is on the pod sandbox**
(`container_name=""`); `machine_cpu_cores`/`machine_memory_bytes` are present. A trimmed
binding scrape is committed at
`apps/studio/lib/api/self-platform/__fixtures__/cadvisor-k8s-scrape.prom` for the
Studio k8s metrics-dialect work (M6.4 D3 extension point). See
`docs/self-hosted-parity/2026-07-08-k8s-single-project-deployment.md`.
