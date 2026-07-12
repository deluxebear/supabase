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
```

- `operator`: durable orchestration/API process; it never requires host shell
  access.
- `agent`: node-local executor transport process; no management listener is
  opened by this scaffold.
- `all`: lightweight single-host packaging that runs both roles in one process
  while retaining the same interfaces.
- `backupctl`: typed administrative API client, not an arbitrary shell wrapper.

## Contracts

- OpenAPI source: `api/openapi/v1/openapi.yaml`
- Agent protobuf source: `api/proto/supabase/backup/agent/v1/agent.proto`
- Generated Go bindings: `gen/openapi/v1` and `gen/proto/v1`
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
