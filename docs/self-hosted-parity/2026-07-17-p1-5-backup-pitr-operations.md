# P1-5 Backup and PITR operations

P1-5 closes the Fleet backup path from inventory and policy through a real point-in-time restore and rollback. Backup Operator remains the durable operation authority, enrolled Backup Agents execute target-local work, and Studio consumes project-scoped management projections without acquiring database, repository, or host credentials.

## Management contract

- Inventory reports completed provider backups and the observed WAL recovery window.
- Policy owns full, differential, and incremental schedules plus retention.
- Manual backup and maintenance requests use durable idempotency keys.
- Restore planning pins the exact cluster identity, recovery target, capacity assessment, impact, provider observations, and plan hash.
- Confirmation and execution require a recent AAL2 assertion and the exact plan hash.
- Job responses expose normalized progress, every persisted attempt, typed execution evidence, safe recovery guidance, and the active rollback deadline.

The UI never treats a configured target with missing observations as success. Failed and orphaned jobs remain actionable through retry/cancel or the confirmed restore rollback path. A successful restore is projected as `rollback-available` only while its durable quarantine window is still open.

## Recovery safety

Single-primary restore preserves the original PGDATA in quarantine, restores to the requested UTC WAL target, verifies the replacement data, and records the cut-over boundary. Rollback uses the same durable job, outbox, mTLS Agent, journal, fencing, and evidence chain. Automatic cleanup cannot remove the original data before the rollback deadline, and ambiguous failure becomes manual intervention rather than false success.

No production or existing development project is an acceptable first restore target. The acceptance test provisions a disposable PostgreSQL + MinIO topology with isolated Docker resources and destroys it afterward.

## Acceptance evidence

The isolated `compose-e2e` acceptance completed the following chain with `RESULT=PASS`:

1. discovered the single-primary pgBackRest topology and MinIO repository;
2. saved full/diff/incremental schedules with 21-day retention;
3. verified healthy WAL archiving and created an idempotent manual full backup;
4. observed 100% progress, attempts, typed evidence, and backup inventory;
5. produced a blocker-free restore plan with capacity and impact;
6. rejected AAL1 and a mismatched confirmation hash;
7. confirmed and executed the exact PITR plan;
8. verified rows at the requested UTC target, then rolled back and verified the post-target row returned.

The chain used the real API, control store, outbox, mTLS Agent, journal, recovery engine, PostgreSQL, pgBackRest, and MinIO. `project-a` and its volumes were never contacted or mutated.
