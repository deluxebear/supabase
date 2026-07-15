# Fleet Control production runbook

Fleet Control is the general stack-management bounded context. Backup policy,
PITR, restore plans, destructive database jobs, and recovery evidence remain
exclusively owned by Backup Operator. The services may share an image build
repository and neutral Agent infrastructure, but never an API namespace,
database, migration ledger, retention policy, or domain payload schema.

## Deployment

Build `Dockerfile.fleet-control` and pin the resulting image digest. Production
uses PostgreSQL with an independent credential, volume, backup, and recovery
procedure outside every managed stack recovery domain:

```bash
cp deploy/fleet-control/compose.env.example deploy/fleet-control/compose.env
docker compose --env-file deploy/fleet-control/compose.env \
  -f deploy/fleet-control/compose.yaml up -d
```

```text
FLEET_CONTROL_STORE_DRIVER=postgres
FLEET_CONTROL_STORE_DSN=postgres://fleet_control:...@fleet-control-db:5432/fleet_control
FLEET_CONTROL_STORE_SYSTEM_IDENTIFIER=fleet-control
FLEET_CONTROL_STORE_DATA_DOMAIN=fleet-control-db-data
FLEET_CONTROL_SERVICE_ASSERTION_ISSUER=studio-platform
FLEET_CONTROL_SERVICE_ASSERTION_AUDIENCE=fleet-control
```

Use a dedicated assertion key of at least 32 random bytes; do not reuse the
Backup Operator assertion key. `/healthz` proves process liveness and `/readyz`
returns success only when the independent Fleet schema is at version 1.

The T4 production assembly deliberately registers no execution provider.
`runtime.observe` therefore returns an explicit `unsupported` capability with a
`provider_not_registered` blocker, and operation creation returns
`capability_unavailable`. Later provider work must register a typed
`supabase.fleet.*` input schema before an operation can be accepted.

## Authorization and isolation

Every management route is under
`/platform/fleet/v1/projects/{projectRef}/...`. The service assertion audience
must be `fleet-control`; reads require `fleet.read`, mutations require
`fleet.execute`, and the assertion project list must contain the exact
`projectRef`. Authorization runs before store access. Operation reads also
filter by both project ref and operation ID, preventing an authorized user of
one project from reading another project's operation.

Operation input is schema-validated, stored as an immutable execution request,
and never returned by the read API. Audit rows record actor, project, target,
operation, and correlation ID without copying typed input or secrets. Event
replay is bounded and cursor based. Fencing tokens are monotonically allocated
per project/target/binding domain in the same transaction as operation creation.

## Upgrade and rollback

Run `make generate`, `make check-generated`, `make build`, `make test`, and
`go vet ./...` before rollout. Protocol major 1 and Fleet schema 1 are the T4
compatibility boundary. Unknown protocol majors, capability names, or
`supabase.backup.*` payload schemas fail before persistence.

Upgrade Fleet Control independently from Backup Operator. Verify `/readyz`,
then exercise project-scoped capability and operation reads with a short-lived
service assertion. Roll back to the previous image digest only while it supports
Fleet schema 1. T5 will add the checksum-locked production migration runner and
rolling-schema compatibility; until then, take an independent PostgreSQL backup
before schema changes and do not edit an applied migration file.

During a managed-stack outage, Fleet Control and `fleet-control-db` must remain
available. Run `docker/self-platform/scripts/verify-control-plane-recovery-boundary.sh`
only in a disposable or explicitly approved environment to prove this boundary.
