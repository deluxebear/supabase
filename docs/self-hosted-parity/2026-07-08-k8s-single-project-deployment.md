# k8s single-project Supabase deployment + cAdvisor fixture capture (2026-07-08)

- **Status**: DONE — full stack live on k3s, binding cAdvisor fixture captured.
- **Why**: the management-plane's **M6.4 D3** extension point (k8s container metrics)
  is gated by the fork's iron rule — _fixture-is-binding: never write a metrics dialect
  blind; capture a real `container\__` scrape from a live cluster first\*. The user has a
  k8s cluster but no Postgres on it, so this milestone stands up a real single-project
  Supabase-on-k8s (fork image) + a cAdvisor DaemonSet, and captures the binding fixture.
- **Deliverable**: reproducible manifests + runbook at `docker/k8s/single-project/`
  (`README.md` + `deploy.sh`); binding fixture at
  `apps/studio/lib/api/self-platform/__fixtures__/cadvisor-k8s-scrape.prom`.

## Cluster

Single-node **k3s v1.36.2+k3s1** — node `ubuntu24vm`, Ubuntu 24.04, **containerd
2.3.2**, amd64, `local-path` default StorageClass, metrics-server present. Reached at
`https://192.168.50.189:6443` via `~/.kube/config` (context `default`).

## What shipped

All 11 compose services ported faithfully (fork `deluxebear/postgres:17` for the db)
plus a cAdvisor DaemonSet. Kong is a k3s ServiceLB `LoadBalancer` on the node IP:8000.
See `docker/k8s/single-project/README.md` for the manifest map, deploy steps,
verification, and the five compose→k8s gotchas that cost real debugging (command-vs-args,
ConfigMap-symlink-vs-subPath, cAdvisor read-only-/var/run, named-volume-auto-population,
`$(VAR)` scope).

Live verification (2026-07-08): 12/12 pods `1/1`; `auth/v1/health` and `storage/v1/status`
return 200 through kong; db serves `select 1` (PG 17.6, 15 schemas); kong key-auth
substituted the anon key correctly; `/rest/v1/` root 403 is the intended admin-only ACL.

## BINDING cAdvisor findings (load-bearing for the Studio k8s dialect)

Captured from the standalone cAdvisor DaemonSet scraping the `supabase-db-0` pod. These
are the exact k8s-vs-compose differences that the M6.4 adapter's k8s branch must encode —
none were writable blind:

| Aspect                                       | compose (shipped, M6.4)                   | **k8s (this capture)**                                                                                               |
| -------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| identity labels                              | `name="supabase-db"`                      | `container_label_io_kubernetes_pod_namespace` + `…_pod_name` + `…_container_name`                                    |
| CPU / memory series                          | single `name=` series                     | `container_name="postgres"` series                                                                                   |
| **network series**                           | same series                               | **`container_name=""` (pod sandbox / pause), interface `eth0`** — NOT the postgres container                         |
| pause-container noise                        | none                                      | a second `container_name=""` sandbox series per pod → **must be filtered**                                           |
| `name=` label                                | friendly (`supabase-db`)                  | containerd task hex → **useless for identity; match the `io_kubernetes_*` labels**                                   |
| `machine_cpu_cores` / `machine_memory_bytes` | present                                   | **present** (8 cores, ~10.16 GB) → `%` denominators available, math reused                                           |
| RAM% denominator                             | limit=0 (unlimited) → machine denominator | **`container_spec_memory_limit_bytes` = pod `limits.memory` (1 GiB here)** → limit path exercised for the first time |

Available `container_*` for the postgres container: `cpu_usage/user/system_seconds_total`,
`memory_working_set_bytes/usage_bytes/rss/cache/swap`, `spec_memory_limit_bytes`,
`spec_cpu_period/shares`, `oom_events_total`, `start_time_seconds`, plus fs/blkio (rootfs,
not the data volume → ignored, disk stays L1 SQL per M6.4 D4).

## Next — Studio k8s metrics dialect (deferred, the original milestone)

With the fixture in hand, the Studio-side work (M6.4 D3) is unblocked. Agreed shape
(**Approach A**): a `stackKind`-keyed identity matcher in
`apps/studio/lib/api/self-platform/metrics.ts` — compose matches `name=`; k8s matches
`namespace + pod_selector + container` and reads **CPU/MEM from `container_name="postgres"`,
network from `container_name=""`**, excluding the pause sandbox; `machine_*` and the
counter-delta rate math are reused verbatim. k8s identity storage = dedicated editable
columns (mirroring M6.4's `container_name`, since `stack_meta` is PATCH-immutable). Bind
the branch to `__fixtures__/cadvisor-k8s-scrape.prom`. That is its own spec → plan →
implement cycle.

## Follow-ups (deployment, non-blocking)

- Persist the db pgsodium key (db-config PVC + copy-on-first-boot initContainer).
- Add the Logflare `analytics` service (kong already routes to `analytics:4000`).
- Ingress + TLS for external access beyond the kong LoadBalancer.
- Optionally run the fork's custom Studio image instead of the upstream one.
