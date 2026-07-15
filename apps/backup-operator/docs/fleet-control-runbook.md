# Fleet Control production runbook

Fleet Control is the general stack-management bounded context. Backup policy,
PITR, restore plans, destructive database jobs, and recovery evidence remain
exclusively owned by Backup Operator. The services may share an image build
repository and neutral Agent infrastructure, but never an API namespace,
database, migration ledger, retention policy, or domain payload schema.

Schema 4 adds durable ownership-safe reconciliation tasks and typed Agent
evidence on top of schema 3 management bindings, hash-only single-use enrollment, Agent CSR
issuance, and short-lived mTLS certificates. The service-assertion listener and
the TLS enrollment listener remain separate from the mTLS-only Agent gRPC
listener on port 8092. Generate and mount the Agent
CA and enrollment server certificate before startup; never place the CA private
key or Agent private keys in the platform store or Studio responses. Protocol
major 1 is required. Rotate Agent certificates before expiry, retain only the
configured short overlap, and revoke all revisions when a binding is detached
or an Agent is replaced.

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
returns success only when the independent Fleet schema is at version 4.

T8 registers `runtime.config.reconcile` with
`supabase.fleet.runtime.config.reconcile.v1` input and
`supabase.fleet.runtime.config.evidence.v1` evidence. Operation creation still
fails with `capability_unavailable` unless the exact active project binding has
an enrolled Agent advertising that capability. The Agent may use only the
Compose or Kubernetes providers described in the
[T8 operations runbook](../../../docs/self-hosted-parity/2026-07-15-t8-ownership-safe-reconciliation-operations.md).

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
`go vet ./...` before rollout. Protocol major 1 and Fleet schema 4 are the T8
compatibility boundary. Unknown protocol majors, capability names, or
`supabase.backup.*` payload schemas fail before persistence.

Upgrade Fleet Control independently from Backup Operator. Verify `/readyz`,
then exercise project-scoped capability and operation reads with a short-lived
service assertion. The runner acquires a PostgreSQL advisory lock, stores the
name and SHA-256 checksum of every migration, and rejects a changed migration at
startup. The first T5 rollout adopts checksum metadata for the pre-T5 schema-1
ledger; every later rollout is strictly locked. Roll back to an image digest only
while it supports Fleet schema 4. Never edit an applied migration; use a forward
repair migration after taking an independent PostgreSQL backup.

Production Compose also runs the same image in `outbox-dispatcher` mode. Its
platform PostgreSQL login can only execute the three security-definer claim,
complete, and fail functions. The dispatcher uses bounded leases and the
platform idempotency key, so a process restart between Fleet Control acceptance
and platform acknowledgement safely replays the original operation. It sends a
project-bound `fleet.execute` assertion and validates the returned project,
operation, desired revision, and digest before acknowledging the outbox row.

During a managed-stack outage, Fleet Control and `fleet-control-db` must remain
available. Run `docker/self-platform/scripts/verify-control-plane-recovery-boundary.sh`
only in a disposable or explicitly approved environment to prove this boundary.
