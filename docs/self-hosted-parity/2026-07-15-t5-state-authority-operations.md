# T5 state authority and migration operations

T5 establishes persistence and delivery mechanics; it does not advertise a runtime configuration provider. T7 must resolve a verified project binding and T8 must register an available typed capability before a browser mutation can be enabled.

## Authority and delivery

- `platform.desired_configurations` is the only editable desired document.
- Desired documents and immutable snapshots contain secret references only, never plaintext secrets.
- `platform.configuration_revisions` and the payload columns of `platform.operation_outbox` are immutable.
- `platform.commit_desired_configuration(...)` updates desired state, appends its revision and outbox row, creates an operation summary, and writes audit context in one transaction with optimistic generation checking.
- `platform-outbox-dispatcher` claims rows through a bounded lease. A crash after Fleet Control acceptance replays the same operation and idempotency key; Fleet Control returns the original durable operation.
- Fleet Control schema 2 stores `desired_revision`, `desired_digest`, and the canonical snapshot. It rejects a digest mismatch or a typed input that differs from the immutable snapshot before persistence.
- `platform.apply_configuration_observation(...)` updates the observed projection only when project, domain, revision, and generation still match current desired state. An older result returns `false` and cannot overwrite the latest projection.

Operation summary reads use `/api/platform/fleet/v1/projects/{ref}/operations/{operationId}`. The route exists only in the Fleet profile, requires the named platform-identity capability, authenticates and authorizes the exact project before querying, and filters by both project ref and operation ID. Embedded Studio returns 404 before touching platform state.

## Migration and readiness

`docker/self-platform/scripts/run-platform-migrations.sh` is the only production platform migration executor. It acquires a PostgreSQL advisory lock, orders migrations lexically, verifies stored SHA-256 checksums, applies each missing file transactionally, rejects changed or removed files, provisions the least-privilege dispatcher login, and releases readiness only after the whole image manifest matches the ledger.

`platform-migrate` is a one-shot Compose service. `platform-auth` and Fleet Studio depend on `service_completed_successfully`; a missing or edited migration therefore fails startup instead of leaving an apparently ready partial control plane. Fleet Control uses the same policy in its independent schema ledger and `/readyz` requires schema 2.

Never edit an applied migration. Add a lexically later file. For a failed forward migration, fix it in a new migration if any environment recorded the original checksum; if no environment committed it, correct the candidate before release. Restore a platform database only with its matching encryption/identity material, then run the migration service before starting Studio.

Schema rollback is forward repair: database objects are not destructively downgraded. Roll back the application image only when its compatibility manifest includes the current schema. Otherwise deploy a forward repair migration.

## Verification

```bash
./docker/self-platform/scripts/verify-platform-state-authority.sh
```

The disposable test proves pre-ledger upgrade, concurrent fresh migration locking, idempotent desired/outbox replay, stale observation rejection, current observation acceptance, and changed-checksum readiness failure.
