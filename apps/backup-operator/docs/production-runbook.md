# Backup Operator production runbook

## Supported matrix

| Environment | Backup | PITR | Automatic replica rebuild | Recovery strategy |
| --- | --- | --- | --- | --- |
| Bare metal/systemd, single primary | pgBackRest | Yes | N/A | In-place with PGDATA quarantine |
| Docker Compose database, host systemd Agent | pgBackRest | Yes | N/A | In-place with volume quarantine |
| Patroni, one primary plus standbys | pgBackRest | Yes | Yes | Restore primary, reconcile DCS, fresh rebuild standbys |
| Kubernetes self-managed `deluxebear/postgres:17` | Built-in pgBackRest 2.58 | Yes | Yes | Replacement StatefulSet/new PVC |
| Kubernetes self-managed `deluxebear/postgres:orioledb-17` | Built-in pgBackRest 2.58 | Yes | Yes | Replacement StatefulSet/new PVC |
| CloudNativePG 1.29.1 + Barman Cloud plugin 0.13.0 | CNPG-I ObjectStore | Yes | Managed by replacement Cluster | Optional replacement-Cluster provider; not required by the default platform |

Always pin an OCI digest in production. A tag alone is not a compatibility guarantee.

## Install and enroll

1. Install the Operator outside the managed database recovery domain.
2. Install one outbound-only Agent per database host, or use restricted Kubernetes task Jobs.
3. Create a dedicated repository and encryption key; never reuse one stanza across unrelated database histories.
4. Enroll Agents with mTLS and verify reported capabilities, image digest, system identifier, topology, pgBackRest version, and repository check.
5. Enable backup policy only after a full backup, WAL switch, and restore drill succeed.

For Docker Compose databases, run only the Operator with
`deploy/compose.yaml`; install the Agent on the database host with
`deploy/systemd/backup-agent.service`. The default distroless Operator image
does not contain pgBackRest or a container runtime, so it is not a supported
Agent image. Do not mount the Docker socket into the Operator. A containerized
Agent is unsupported until a dedicated restore image and a policy-limited
runtime proxy are explicitly configured and validated.

## Restore

1. Review recoverability evidence. `unknown` blocks restore; `inferred` is weaker than `drill-verified`.
2. Confirm topology, capacity margin, repository revision, provider versions, and fence coverage.
3. Complete AAL2 confirmation for the exact plan hash.
4. Engage the write fence and verify zero writers, prepared transactions, and alternate primaries.
5. Do not transfer a running destructive task after lease expiry. Mark it orphaned and reconcile the original Agent result.
6. Validate the restored target in isolation before timeline/archive reconciliation and cutover.
7. Keep the original PGDATA/PVC quarantined through the rollback window.

## Manual intervention

- `dcs-unavailable`: keep data-plane fencing engaged; restore DCS quorum before topology decisions.
- `leader-mismatch` or dual primary: isolate every PostgreSQL endpoint and resolve authority manually.
- standby `manual`: do not attach the old PGDATA; provision a fresh replica from the recovered primary.
- `archive pollution`: disable repository writes, preserve both histories, and contact the storage administrator.
- Agent orphan: do not issue a takeover token; recover the Agent journal or inspect the host directly.

### Log backpressure

When bounded Agent log or progress queues drop entries, preserve job state and evidence first. Reduce verbose log production, confirm the control store is responsive, and scale consumers before increasing queue capacity. Progress logs are diagnostic and must never become an unbounded memory buffer.

### Repository and WAL health

Stop scheduling expiration when repository checks fail or WAL continuity regresses. Do not claim a gap-free PITR window from archive min/max observations. Repair archive delivery, force a WAL switch, run `pgbackrest check`, and complete an isolated recovery drill before restoring verified status.

### WAL gap or stale evidence

Keep PostgreSQL stopped and the write fence engaged. Select a target inside server-observed continuous coverage, or repair archive delivery and create a new plan after a successful isolated drill. Never reuse the previous confirmation.

### Identity mismatch

Preserve the original and failed recovery data directories. Compare the enrolled repository fingerprint, stanza, system identifier, database history, and image major version. Correct enrollment and create a new plan; do not rewrite repository metadata to make it match.

### Capacity or disk full

Keep repository writes disabled and preserve both data directories. Add capacity on the enrolled destination, verify the new observation, and create a new plan. Do not delete quarantine data to make an active restore fit.

### Repository unavailable or throttled

Keep the repository read-only. Restore connectivity or allow throttling to clear, then retry with bounded backoff only if the failed step has an absent postcondition; uncertain side effects require orphan reconciliation.

### Agent disconnection

Do not transfer an in-flight destructive task merely because its Agent disconnected. Inspect the Agent journal and reconcile its original result. Safe, idempotent inspection work may be retried after the original task is proven stopped.

### Orphaned destructive task

Inspect the durable outbox, Agent journal, recovery execution, and real host postcondition. Record the observed result against the original task and fencing token. Never issue a takeover token while the original process may still be running.

### Lease expiry

Lease expiry does not authorize task transfer. Mark the execution orphaned, preserve its fence, and reconcile the original Agent result before retry, compensation, or manual recovery.

### Archive pollution

Disable repository writes, preserve old and recovered timeline histories, and stop expiration. Resolve the archive identity collision and complete `pgbackrest check` plus an isolated drill before re-enabling writes.

### Cutover response loss

Read the stable Service, route, or project-registry identity and compare its resource version with the durable recovery state. If cutover committed, record success without replay; otherwise compensate or retry only after proving the side effect absent.

### Write fence release failure

Treat release errors as fail-closed. Verify data-plane, pooler, service, and direct PostgreSQL gates individually. Keep or re-engage every gate until all release adapters are healthy, then retry using the original fence handle and record the diagnostic evidence.

### Event and audit retention

Retention must archive a bounded batch transactionally before deleting active rows. On failure, stop pruning, verify archive durability and export audit records required by policy, then retry the same batch. Never delete audit rows to relieve control-store pressure without a verified archive.

### SSE cursor expiry

When `Last-Event-ID` predates retained history, return the current job snapshot and its cursor. Clients must replace local state with that snapshot before resuming incremental events; they must not interpret a partial replay as complete history.

## Upgrade and rollback

1. Rotate certificates using a dual-trust window and confirm every Agent reports the pending CA.
2. Upgrade Operators first only for protocol-minor compatible releases; protocol-major changes require a planned outage.
3. Existing destructive jobs stay pinned to the Agent build captured in their confirmed plan.
4. Roll Agents one host at a time outside active backup/restore jobs.
5. Roll back by restoring the previous digest. Database/repository schema migrations must remain backward-readable for the documented release window.

## Quarantine cleanup

Cleanup is eligible only after `rollback_until`, when `manual_lock=false`. The Operator claims bounded cleanup batches, performs the external delete, and records success/failure in the audit log. A failed delete returns the resource to `quarantined` state.

## Release verification

Verify `SHA256SUMS`, the Sigstore bundle, GitHub provenance attestation, image signature, image SBOM, and pinned digest before deployment.

The release workflow builds `linux/amd64` and `linux/arm64` Operator and `backupctl` binaries, generates checksums and an SPDX SBOM, signs the checksum file and OCI digest through keyless Sigstore, and publishes GitHub build provenance. A local `make release-snapshot VERSION=vX.Y.Z` creates unsigned binaries and verifies their checksums; it does not represent a signed release.

Verify downloaded release assets before use:

```bash
sha256sum --check SHA256SUMS
cosign verify-blob --bundle SHA256SUMS.sigstore.json \
  --certificate-identity-regexp='https://github.com/supabase/supabase/.github/workflows/backup-operator-release.yml@refs/tags/backup-operator/v.*' \
  --certificate-oidc-issuer=https://token.actions.githubusercontent.com SHA256SUMS
cosign verify \
  --certificate-identity-regexp='https://github.com/supabase/supabase/.github/workflows/backup-operator-release.yml@refs/tags/backup-operator/v.*' \
  --certificate-oidc-issuer=https://token.actions.githubusercontent.com \
  ghcr.io/supabase/backup-operator@sha256:REPLACE_WITH_RELEASE_DIGEST
```

## backupctl

`backupctl` emits typed JSON and uses stable exit codes: `0` success, `1` operation failure, `2` invalid usage, `3` authentication/authorization, `4` not found, `5` conflict, `6` Operator unavailable, and `7` failed safety confirmation. Set `BACKUP_OPERATOR_URL` and `BACKUP_OPERATOR_TOKEN`, or pass `--endpoint` and `--token` before the command.

```bash
backupctl cluster list
backupctl cluster get --id CLUSTER
backupctl policy get --cluster CLUSTER
backupctl policy apply --cluster CLUSTER --input policy.json
backupctl backup run --cluster CLUSTER --type full
backupctl job watch --id JOB --interval 2s
backupctl job cancel --id JOB
backupctl job retry --id JOB
backupctl restore plan --cluster CLUSTER --target 2026-07-13T01:00:00Z
backupctl restore confirm --plan PLAN --hash HASH --confirm-hash HASH
backupctl restore execute --plan PLAN --hash HASH --confirm-hash HASH
backupctl restore rollback --job JOB --hash HASH --confirm-hash HASH
backupctl maintenance run --cluster CLUSTER --kind repository-check
backupctl audit export --after 0 --limit 1000
```

The CLI has no arbitrary shell or arbitrary maintenance command. Restore confirmation, execution, and rollback require the separately repeated exact plan hash. Keep credentials out of shell history by preferring `BACKUP_OPERATOR_TOKEN` sourced from a protected secret manager.

## Isolated restore drills

The Operator runs configured restore drills in a separate PGDATA and with repository writes disabled. A successful drill is durable only after target validation and isolation cleanup both complete. Inspect `GET /v1/clusters/{clusterId}/backups` for `drill`, `recoveryWindow`, and `confidence`; only a lineage-matching successful record upgrades confidence to `drill-verified`.

Enable the coordinator with `BACKUP_OPERATOR_RESTORE_DRILL_ENABLED=true`, `BACKUP_OPERATOR_RESTORE_DRILL_INTERVAL`, `BACKUP_OPERATOR_RESTORE_DRILL_TARGET_LAG`, and a positive `BACKUP_OPERATOR_RESTORE_DRILL_LEASE_TTL` shorter than the interval. The target is always derived from the server backup/WAL/repository observation path; a WAL gap prevents capability resolution and task creation.

On the enrolled systemd Agent, set all of the following:

- `BACKUP_AGENT_DRILL_ENABLED=true` and `BACKUP_AGENT_DRILL_REPOSITORY_READ_ONLY=true`.
- `BACKUP_AGENT_DRILL_STATE` on durable Agent state storage.
- `BACKUP_AGENT_DRILL_WORKSPACE_ROOT` on a filesystem device different from production PGDATA, and repeat the exact root in `BACKUP_AGENT_DRILL_ALLOWED_ROOTS`.
- `BACKUP_AGENT_DRILL_MINIMUM_FREE_BYTES` to the restore capacity reservation.
- `BACKUP_AGENT_DRILL_VALIDATOR_BINARY` to a root-owned, non-group/world-writable validation harness, and repeat the exact path in `BACKUP_AGENT_DRILL_VALIDATOR_ALLOWED_BINARIES`.
- `BACKUP_AGENT_DRILL_VALIDATOR_TIMEOUT` to a bounded positive duration.

The enrolled validation harness receives fixed typed flags for PGDATA, UTC target time, expected database system/history IDs, read-only mode, target-data validation, and disabled networking. It must start only the isolated copy and emit one strict JSON evidence object containing decimal-string `databaseSystemId` and `databaseHistoryId` values (strings preserve the full unsigned 64-bit PostgreSQL identifiers), plus `timeline`, `readOnly`, `targetDataVerified`, `observedTargetTime`, `startupMode: "isolated"`, and `networkExposure: "disabled"`. Any mismatch, extra field, stderr output, timeout, or cleanup failure fails the task. Mount the workspace root as its own volume; a directory on the production PGDATA filesystem is rejected even when its pathname differs.

For `BackupOperatorRestoreDrillFailed`, keep production untouched, preserve the drill evidence, and inspect the isolated restore and cleanup errors. For `BackupOperatorRestoreDrillStale`, verify that the drill worker is running, that a target inside the inferred WAL window is available, and that the read-only repository credential can restore. Never grant repository write access to make a drill pass.
