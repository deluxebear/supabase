# Fleet upgrade, migration, failure, and rollback runbook

- Date: 2026-07-16
- Applies to: Fleet Studio, platform identity/registry, Fleet Control, Backup Operator, and enrolled Agents
- Goal: make every release reversible where possible and explicitly recoverable where reversal is unsafe

## 1. Required release evidence

Record these values before changing production:

- source revision and upstream base;
- Studio deployment profile and image digest;
- platform, Fleet Control, and Backup Operator schema ledger heads;
- Fleet Control, Backup Operator, and Agent protocol/build versions;
- encrypted control-store snapshot identifiers and restore checksums;
- CA, assertion-key, and encryption-key backup identifiers;
- current project binding, capability, desired revision, observed revision, and active operation summaries;
- latest successful Backup restore-drill evidence for critical projects.

Never print credentials, private keys, encrypted DSNs, enrollment tokens, or full operation payloads into the release log.

## 2. Preflight

1. Confirm all three control stores are outside every managed stack recovery domain.
2. Verify snapshots and authority-key backups can be read by the recovery operator.
3. Run the platform migration authority acceptance and control-plane DR/recovery-boundary drills.
4. Run focused Studio and Go tests plus the real two-instance Compose acceptance.
5. Reject the release if any target has a destructive job in `planned`, `confirmed`, `running`, `rolling-back`, or `manual-intervention` unless the incident owner explicitly freezes it.
6. Compare component versions with the published compatibility matrix. Major protocol skew fails closed.
7. Select a canary organization and at least one canary target for every installed provider kind.

## 3. Upgrade order

Use expand/migrate/contract sequencing. New readers must tolerate the old schema before old writers are removed.

1. Snapshot the platform, Fleet Control, and Backup Operator stores and authority material.
2. Deploy checksum-locked platform migrations. Readiness stays closed until the ledger is complete and verified.
3. Deploy Fleet Control migrations and service. Confirm queue, event, capability, and Agent-session health.
4. Deploy Backup Operator migrations and service. Confirm readiness without starting a destructive job.
5. Roll Agents by canary target, then provider cohort. Preserve bounded certificate overlap during rotation.
6. Deploy Fleet Studio built with the `fleet` profile and verify its image label/revision.
7. Run canary attachment/status, runtime reconciliation, lifecycle dry-run/impact plan, Edge Function probe, and Backup observation.
8. Expand to remaining organizations in bounded cohorts. Stop on an SLO breach, protocol mismatch, migration error, or unexplained capability loss.
9. Run contract cleanup only in a later release after every old reader/writer version is outside the supported window.

## 4. Migration failure experience

| Failure                              | Required behavior                                             | Operator action                                                                               |
| ------------------------------------ | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Changed or removed applied migration | Readiness fails with checksum evidence                        | Restore the exact migration file; ship a new forward migration for changes                    |
| Concurrent migration runners         | One runner owns the advisory lock; peers wait or exit cleanly | Do not bypass the lock; inspect the durable ledger                                            |
| Transactional migration error        | The migration is not recorded as applied                      | Fix the new migration and rerun before opening readiness                                      |
| New service cannot read old data     | Canary remains unavailable                                    | Roll back the application image if schema is still backward compatible; otherwise forward-fix |
| Store unavailable                    | API fails closed; durable target state is not guessed         | Restore connectivity or execute the rehearsed store recovery procedure                        |
| Authority key/CA missing             | Readiness and Agent trust fail closed                         | Restore the matching backed-up authority material; never generate a replacement in place      |

Database schema rollback by applying old SQL is prohibited. Migrations are append-only. Use an application rollback only while the migrated schema remains backward compatible; otherwise use a forward fix. A catastrophic store restore must restore the store and its matching encryption/assertion/CA material to one coordinated recovery point.

## 5. Failure and degradation matrix

| Fault                                         | User-visible state                                                            | Safe continuation                                                                  | Recovery                                                                            |
| --------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Studio unavailable                            | UI/API unavailable; Agents keep no new intent                                 | Existing data plane and durable control jobs continue according to their contracts | Roll back/redeploy Studio; no target mutation is required                           |
| Attached data plane unavailable               | Data-plane health becomes unhealthy independently                             | Other projects and management domains remain usable                                | Repair target; refresh probes; do not rewrite desired state                         |
| Fleet Agent offline                           | Management connectivity offline; runtime/lifecycle/functions actions disabled | Direct data-plane features remain available when healthy                           | Restore/replace Agent, rotate enrollment, observe compatibility                     |
| Fleet Control unavailable                     | General management actions unavailable                                        | Backup bounded context and direct data-plane features remain independent           | Restore service/store and replay durable outbox/tasks idempotently                  |
| Backup Operator unavailable                   | Backup pages show correlated offline state                                    | General Fleet management remains independent                                       | Restore Operator/store and re-probe; do not claim current recovery evidence         |
| Backup Agent offline                          | Backup jobs pause/fail with durable evidence                                  | Existing backups remain immutable                                                  | Repair/replace Agent; resume only through fenced task state                         |
| Target operation loses postcondition evidence | Operation is not reported successful                                          | Other projects continue; target is fenced as required                              | Roll back when proved safe, otherwise enter `manual-intervention`                   |
| Control-store loss                            | Affected bounded context unavailable                                          | Managed data planes remain untouched                                               | Restore rehearsed snapshot plus matching authority keys, then reconcile projections |

## 6. Rollback decision

### Application-only rollback

Allowed when the new schema is explicitly backward compatible and no new irreversible provider action has executed. Roll back the affected service image, verify readiness, then verify outbox/task replay and capability projections.

### Target operation rollback

Use only the durable job's recorded rollback plan and immutable execution snapshot. Never run an ad hoc shell command from Studio. The Agent must fence the operation, verify the previous revision/pointer/workload, execute the typed rollback, and publish postcondition evidence. If any step is uncertain, retain the last proved state and mark `manual-intervention`.

### Control-store restore

Use only for catastrophic loss or corruption. Stop writers, restore the three stores independently to documented points, restore matching authority material, run checksum verification, start services with readiness closed, reconcile immutable operations/outbox/observations, and reopen traffic only after the DR acceptance passes. Do not restore a managed target merely to recover the control plane.

## 7. Post-release verification

- No migration ledger mismatch or readiness bypass exists.
- No project binding, credential revision, ownership policy, or active artifact digest changed without a corresponding audit event.
- Agent sessions, queue depth, retry rate, error rate, and latency remain within the T10 SLO envelope.
- Capability losses have typed blockers and affect only the intended target/domain.
- Two-instance routing still returns distinct PostgreSQL system identifiers.
- Backup status is either proven available or explicitly unconfigured/offline/incompatible/unauthorized with a correlation ID.
- At least one canary project completes the provider-specific verification and rollback rehearsal required by its risk class.

## 8. Acceptance commands

Run from the repository root:

```bash
docker compose --env-file docker/self-platform/.env.example \
  -f docker/self-platform/docker-compose.yml config >/dev/null
docker/self-platform/scripts/verify-platform-state-authority.sh
docker/self-platform/scripts/verify-honest-attachment.sh
docker/self-platform/scripts/verify-management-trust.sh
docker/self-platform/scripts/verify-ownership-reconciliation.sh
docker/self-platform/scripts/verify-edge-function-deployments.sh
(cd apps/backup-operator && go test ./...)
```

The multi-instance acceptance never discovers or starts a Supabase CLI project. Supply
the independently managed Docker Compose target explicitly:

```bash
TARGET_DB_CONTAINER=managed-b-db \
TARGET_KONG_CONTAINER=managed-b-kong \
TARGET_DB_HOST=host.docker.internal \
TARGET_DB_PORT=55432 \
TARGET_GATEWAY_URL=http://host.docker.internal:55421 \
TARGET_DB_PASSWORD='<target database password>' \
TARGET_ANON_KEY='<target anonymous key>' \
TARGET_SERVICE_ROLE_KEY='<target service-role key>' \
TARGET_JWT_SECRET='<target JWT secret>' \
docker/self-platform/scripts/verify-multi-instance-e2e.sh
```

Production control-plane recovery also requires:

```bash
docker/self-platform/scripts/verify-control-plane-recovery-boundary.sh
docker/self-platform/scripts/verify-control-plane-dr.sh
```

Those two commands require a configured production control-plane environment and must not be replaced with the development all-in-one topology.
