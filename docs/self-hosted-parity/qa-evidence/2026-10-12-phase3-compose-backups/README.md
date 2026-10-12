# Phase 3 evidence: backups on Fleet Compose stacks

Local environment, 2026-10-12. Stack `project-d` (`supabase-managed-d`), control plane `supabase-fleet-control`, repository RustFS (`backup-repository`).

## End-to-end script

`docker/self-platform/scripts/verify-compose-backups.sh project-d -- <stack Compose arguments>` passed on its first run. Output: [verify-compose-backups.txt](./verify-compose-backups.txt). It checked, in order:

1. Discovery and PITR status come from the backup Agent's observation.
2. A full backup through the Operator.
3. Rows written before and after a target time.
4. An on-demand isolated restore drill; recovery confidence became `drill-verified`.
5. An in-place PITR restore to the target time: only the earlier row remained, and the gateway, Auth, PostgREST, and Storage ran again after cut-over.
6. A rollback: both rows and the services returned.
7. The backup Docker proxy refused another project's container and a service outside the fence (HTTP 403).
8. The drill's read-only repository user could not write to the bucket.

## Studio

Studio `supabase-studio:phase3b` (Fleet profile), project-d, signed in as the platform administrator:

- **Backups → Scheduled**: provider `single-primary-pgbackrest`, topology `static-primary · project-d-db`, repository `s3://fleet-backup-project-d/pgbackrest`, PITR healthy, the backup policy, three full backups, confidence `drill-verified`, and the latest drill with its evidence digest.
- **Start full backup**: the job ran through the Agent and the backup appeared in the list.
- **Preview restore impact**: created a plan and showed its hash and the destructive-restore confirmation. The restore was not executed from Studio; the same Operator calls ran in the script.
- **Backups → Point in time**: PITR healthy, repository, confidence, and the recovery window.

## Earlier stages

Stages 3.1 to 3.4 were verified live on the same environment; the results and the defects found are in section 9 of the [design](../../2026-10-12-phase3-compose-backups-design.md).
