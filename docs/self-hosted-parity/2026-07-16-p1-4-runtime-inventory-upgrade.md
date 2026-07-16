# P1-4 Runtime inventory and upgrade readiness

P1-4 replaces hosted capacity/version placeholders with a typed Fleet observation. Fleet Control remains the durable operation authority, the enrolled Agent owns target-scoped collection, and `platform.runtime_inventories` is only the Studio read projection.

## Runtime contract

- Capability: `runtime.observe`
- Input: `supabase.fleet.runtime.observe.v1`
- Evidence: `supabase.fleet.runtime.observe.evidence.v1`
- Studio API: `GET /api/platform/fleet/v1/projects/{ref}/runtime-inventory`
- Compatibility APIs: `disk`, `disk/util`, `disk/custom-config`, `service-versions`, and `upgrade/eligibility`

The evidence contains filesystem size/used/available bytes, PostgreSQL database and WAL bytes, residual system bytes, host CPU/memory, scoped Compose containers and volumes, service images/versions/health, and an upgrade assessment. Refresh uses the shared P1-2 idempotent operation lifecycle and persists only schema-validated evidence.

## Compose trust boundary

The generic Fleet Agent never receives the Docker socket. A target-local `fleet-compose-observer` sidecar is the only socket consumer and exposes bounded GET-only inventory on the target's private default network. It filters Docker data by the exact `com.docker.compose.project` label, never returns environment variables or secrets, mounts the database volume read-only, runs with a read-only root filesystem and `no-new-privileges`, and excludes the successful one-shot enrollment bootstrap from service health.

The Agent separately reads PostgreSQL size and version information over its project-local admin connection. The DSN is never included in evidence, logs, or Studio responses.

## Honest upgrade state

Inventory, preflight checks, an ordered plan, durable progress vocabulary, rollback, and failure recovery are always visible. A Compose target without an allowlisted major-upgrade executor remains `eligible: false` with `provider_not_registered`; an empty local compatibility catalog adds `no_approved_target`. The UI cannot create a fake upgrade operation or report success when no execution provider exists.

## Live acceptance

On `project-b`, the deployed Agent observed 12 long-running Compose services, five volumes, 12 host CPU cores, 15.66 GiB memory, PostgreSQL 17.6, database/WAL/system byte classification, and all service image versions. The six previously missing endpoints returned 200 under project RBAC. Studio rendered capacity, version health, preflight, blockers, plan, rollback, recovery, containers, and volumes with no permanent skeleton or false bootstrap alert. Evidence: `/.gstack/qa-reports/screenshots/p1-4-infrastructure-runtime.png`.

No database, volume, backup reference, or project identity was mutated during acceptance.
