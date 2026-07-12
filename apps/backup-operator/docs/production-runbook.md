# Backup Operator production runbook

## Supported matrix

| Environment | Backup | PITR | Automatic replica rebuild | Recovery strategy |
| --- | --- | --- | --- | --- |
| Bare metal/systemd, single primary | pgBackRest | Yes | N/A | In-place with PGDATA quarantine |
| Docker Compose, single primary | pgBackRest | Yes | N/A | In-place with volume quarantine |
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
