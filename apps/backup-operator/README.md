# Supabase Backup Operator

Lightweight Go control plane and host/Kubernetes Agent for the self-hosted
Supabase backup and PITR architecture.

The provider packages implement verified single-primary, Patroni, customized
Postgres Kubernetes, and optional CloudNativePG/CNPG-I recovery strategies.
Destructive execution remains gated at runtime by fresh topology, write-fence,
capacity, repository, plan-hash, AAL2, and version-pin evidence.

## Binary modes

```bash
go run ./cmd/backup-operator --mode operator --listen 127.0.0.1:8080
go run ./cmd/backup-operator --mode agent
go run ./cmd/backup-operator --mode all --listen 127.0.0.1:8080
go run ./cmd/backupctl --endpoint http://127.0.0.1:8080 capabilities
FLEET_CONTROL_SERVICE_ASSERTION_KEY=replace-with-at-least-32-bytes \
  go run ./cmd/fleet-control --listen 127.0.0.1:8090
```

- `operator`: durable orchestration/API process; it never requires host shell
  access.
- `agent`: node-local executor transport process; no management listener is
  opened by this scaffold.
- `all`: lightweight single-host packaging that runs both roles in one process
  while retaining the same interfaces.
- `backupctl`: typed administrative API client, not an arbitrary shell wrapper.
- `fleet-control`: a separate general stack-management API and store domain. It
  shares only neutral transport validation, fencing allocation, and event replay
  primitives with Backup Operator; it has no backup or restore routes.

## Docker Compose deployment

The default Compose manifest runs only the Operator control plane. Copy
`deploy/compose.env.example` to a protected environment file, replace the
service assertion key, load it into the shell, and start the Operator:

```bash
set -a
. deploy/compose.env
set +a
docker compose -f deploy/compose.yaml up -d
```

Install `deploy/systemd/backup-agent.service` on every PostgreSQL host. The
Agent must retain host-level access to PostgreSQL, pgBackRest, and the recovery
filesystem when the database container is stopped or replaced. The project
does not claim support for running that Agent from the default Compose image;
a future containerized Agent requires a dedicated restore image and a
policy-limited container-runtime proxy.

The Helm and Kustomize manifests expect an existing Secret named
`backup-operator-secrets` with a `service-assertion-key` entry containing at
least 32 random bytes. They provision a single-replica SQLite control-store PVC
by default. Set `persistence.existingClaim` in Helm, or replace the Kustomize
PVC, when the platform owns durable storage. PostgreSQL control-store
deployments should override the driver and DSN from a protected Secret.
The bundled Helm values are intentionally restricted to one replica because
the default control store is SQLite on a `ReadWriteOnce` volume.

## Contracts

- OpenAPI source: `api/openapi/v1/openapi.yaml`
- Agent protobuf source: `api/proto/supabase/backup/agent/v1/agent.proto`
- Fleet OpenAPI source: `api/openapi/fleet/v1/openapi.yaml`
- Neutral/Fleet protobuf sources: `api/proto/supabase/agent/transport/v1/transport.proto`
  and `api/proto/supabase/fleet/agent/v1/fleet.proto`
- Generated Go bindings: `gen/openapi/v1`, `gen/openapi/fleet/v1`, and
  the corresponding `gen/proto` packages
- Provider contracts: `internal/contracts`
- Optional CloudNativePG/CNPG-I adapter: `internal/cloudnativepg`
- Production operations and compatibility matrix: `docs/production-runbook.md`

Regenerate and verify contracts:

```bash
make generate
make check-generated
```

All generator and plugin versions are pinned by the generation script and
`buf.gen.yaml`.

## Validation

```bash
make build
make test
go vet ./...
go run github.com/bufbuild/buf/cmd/buf@v1.50.0 lint
```

Fleet Control operational deployment and rollback guidance is in
`docs/fleet-control-runbook.md`; its standalone Compose manifest is under
`deploy/fleet-control/`. Embedded Studio does not import or start this
binary and retains the upstream self-hosted behavior.
