# M5 customized Postgres Kubernetes replacement evidence

Date: 2026-07-12

## Implementation

- Lightweight Kubernetes provider with no client-go or managed database operator dependency.
- Explicit image allowlist for `deluxebear/postgres:17` and `deluxebear/postgres:orioledb-17`.
- Compatibility binds the managed pgBackRest binary, version, configuration, system identifier, roles, Services, StatefulSet, PVC UID/access mode/attachment, and capacity.
- Operator-owned workloads fail closed and are not modified by the self-managed provider.
- Restricted task Jobs use a closed capability map, no shell interpolation, read-only root filesystem, non-root execution, dropped Linux capabilities, runtime-default seccomp, no mounted ServiceAccount token, deadline, and zero retries.
- Replacement recovery requires a new StatefulSet and new PVCs, performs a repository-read-only restore, validates through an isolated Service, fences the old data plane, switches the stable Service/project registry, and quarantines the old workload.
- Registry cutover failure reverts the stable Service. Rollback switches the Service/registry back before deleting the replacement.
- Least-privilege namespaced RBAC is provided in `apps/backup-operator/deploy/kubernetes/backup-operator-rbac.yaml`.

## Destructive matrix

Both variants passed a real Kind replacement-PVC run:

```text
PG17:       custom-image-pgBackRest-2.58.0, RESULT=PASS
OrioleDB17: custom-image-pgBackRest-2.58.0, RESULT=PASS
```

For each image the isolated and cutover Service returned only `before-target`; rollback returned `before-target,after-target`. The recovered PVC UID differed from the source, while source PVC/PV and Pod identity remained unchanged. OrioleDB17 preflight includes its required Supabase role and extension initialization.

The existing provider still fails closed if a future image digest removes the managed binary/configuration or fails its image-specific initialization.
