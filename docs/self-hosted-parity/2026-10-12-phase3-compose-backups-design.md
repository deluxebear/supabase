# Phase 3: backups on Fleet Compose stacks (design and plan)

- Date: 2026-10-12
- Branch: `custom/main`
- Status: approved 2026-10-12 (option B). Done: stages 3.1 to 3.5 passed on 2026-10-12; see section 9 and the [evidence](./qa-evidence/2026-10-12-phase3-compose-backups/README.md).
- Inputs: Phase 3 of the [completion roadmap](./2026-09-28-fleet-completion-roadmap.md), the [Go Backup Operator architecture](./2026-07-12-go-backup-operator-architecture.md), `apps/backup-operator/docs/production-runbook.md`, and a code audit of `apps/backup-operator` and `docker/fleet-managed` on 2026-10-12.

## 1. Goal

Meet release gate 5 on a Fleet-managed Compose stack: scheduled backups, PITR, an isolated restore drill, and an in-place PITR restore, all driven from Studio through the Backup Operator.

Done when:

- The Backups and PITR pages show real jobs and a recovery window for a managed project.
- A scheduled full backup, an isolated restore drill, and a PITR restore to a timestamp pass on the local environment, and the evidence is stored under `docs/self-hosted-parity/qa-evidence/`.
- Enabling backups on an existing project (for example `project-d`) is a documented, reversible procedure.

Repository decision: the control plane runs one RustFS service, with one bucket and one credential pair per project. This follows decision 3 of the roadmap (one S3-compatible repository per project). Any S3-compatible service can replace RustFS through configuration.

## 2. What exists and what is missing

| Area                       | State                                                                                                                                                                                                                                                                                                           |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pgBackRest in the DB image | `deluxebear/postgres:17` ships pgBackRest 2.58.0 at `/usr/bin/pgbackrest`. Roadmap step 1 needs no derived image. `archive_mode` is `off` on managed stacks.                                                                                                                                                    |
| Recovery engine            | Complete: backup, PITR enable, restore planning with safety inputs, write fence, isolated validation, cutover, rollback window, quarantine cleanup (`internal/singleprimary`, `internal/recoveryexec`).                                                                                                         |
| Docker runtime             | `internal/runtime/docker_recovery.go` drives an enrolled DB container and a validation container through the Docker Engine API. Restore drills are not implemented for it (`RestoreDrill` returns "not configured").                                                                                            |
| Tested topology            | `test/e2e/single-primary-minio.sh`: Operator and Agent share one container on the database host, mount PGDATA and the raw Docker socket, and the Operator runs pgBackRest and reads PGDATA capacity locally. A shell loop produces the WAL inventory file.                                                      |
| Control plane              | `backup-operator` runs in operator mode with a PostgreSQL control store in `platform-db`. No Agent gRPC listener is configured. `backup-operator-tls` exposes the HTTP API on the management network.                                                                                                           |
| Studio                     | The Fleet profile already proxies backup requests through the `backup-operator` management domain. `project-d`'s binding allows `backup.`, but no cluster is registered, so the domain is `unavailable` (`GET /v1/clusters/project-d/backup-policy` returns 404).                                               |
| Operator registration      | The single-primary provider is configured by process flags for exactly one project. Discovery, PITR status, restore observations, and recoverability come from probes that run inside the Operator process: a PostgreSQL DSN, a local pgBackRest binary, a local capacity path, and a local WAL inventory file. |
| Agent enrollment           | The Operator reads one static enrollment file at startup (`BACKUP_OPERATOR_AGENT_ENROLLMENT_FILE`), so it accepts one Agent.                                                                                                                                                                                    |
| Write fence                | The Compose fence calls a fixed command with seven entry points (`kong-data-plane`, `supavisor`, `auth`, `storage`, `realtime`, `background-jobs`, `direct-postgres`) and `block`, `status`, `unblock`. The E2E fence only writes marker files.                                                                 |
| Data volume layout         | Managed stacks mount the DB volume directly at PGDATA. Restore renames PGDATA to a sibling `PGDATA.backup-operator-quarantine`, so PGDATA must be a subdirectory of the volume.                                                                                                                                 |
| Drill workspace            | Drills require a workspace on a different filesystem device from PGDATA. Two named Docker volumes on one host share a device (verified locally), so a named volume is rejected.                                                                                                                                 |

## 3. Key decision: where the Operator observes from

The recovery engine is ready, but its observation side assumes the Operator runs next to the database. A Fleet control plane serves many stacks on other hosts, so this must change. There are two ways to do it.

**Option A: one Operator per stack.** Run `backup-operator --mode=all` inside each stack's backup overlay, exactly like the tested E2E topology, with its control store in a per-project database on the central `platform-db`. Studio routes each project to its stack's Operator.

- Reuses the tested topology almost unchanged.
- Violates two rules of the architecture: the Operator must run outside the managed database's recovery domain, and backup evidence must stay readable during a stack outage. If the stack host is lost, Studio cannot show its backups until a new stack runs.
- All projects share one management target, so Studio needs per-project routing for the `backup-operator` domain. That routing would be thrown away if the design later moves to option B.

**Option B (chosen): one central Operator, Agents report observations.** The control-plane Operator serves every project. Each stack runs only a backup Agent. Everything the Operator now probes locally becomes an Agent task that returns typed evidence, which the Operator stores and reads with a freshness bound.

- Matches the architecture: the Operator and its evidence stay available when a stack is down.
- Task results already carry `typed_evidence`, so no protocol change is needed.
- Costs more Go work in observation code: roughly one to two weeks more than option A.

Option B was chosen on 2026-10-12. The rest of this document assumes it.

## 4. Design

### 4.1 Topology

```
Control plane                                   Managed stack (opt-in `backup` overlay)
--------------------------------------------    -----------------------------------------------
backup-operator (operator mode)                  db                 PGDATA = <volume>/data
  HTTP  :8080  <- backup-operator-tls <- Studio  db-validation      same volume, created, not started
  gRPC  :8443  (mTLS, management network) <----- backup-agent       pgBackRest + Operator binary
  control store: platform-db/backup_operator                        mounts the volume and DB socket
rustfs (S3)  <---------------------------------- archive-push (db), backup/restore (agent)
  one bucket and key per project                 fleet-docker-proxy-backup   policy `backup`
```

### 4.2 Managed stack overlay

A new `docker/fleet-managed/docker-compose.backup.yml`, applied after the existing overlays, adds or changes these services:

- **`db`**: mounts the data volume at `/var/lib/postgresql` (the parent of the image's default PGDATA, `/var/lib/postgresql/data`), adds a shared socket volume at `/var/run/postgresql`, and mounts the `backup-config` volume read-only at `/etc/pgbackrest`. pgBackRest cannot take a consistent backup without WAL archiving, so enabling backups turns archiving on with `ALTER SYSTEM`, using exactly the `archive_command` the Operator's PITR workflow sets. That workflow accepts a matching command as its own.
- **`backup-config-init`**: a one-shot service that copies the project's `pgbackrest.conf` (mode 0600) and the repository CA from the host into the `backup-config` volume, owned by the `postgres` user (UID 100). A direct read-only bind mount of a 0600 host file is not readable by UID 100 on Linux hosts.
- **`db-validation`**: the same image, volume, and configuration as `db`, listening only on its Unix socket (port 5433). It joins the management network to fetch WAL from the repository during recovery. It is created but never started by Compose (`restart: "no"` and a `backup-validation` profile); only the Agent starts it during a restore, after `db` has stopped. It runs with `archive_mode=on` and an empty `archive_command`, so promotion marks the new timeline's history file ready without archiving it; `db` archives it after cut-over. With archiving off, the history file never reached the repository and a later restore reused the timeline ID.
- **`backup-agent`**: a `supabase-backup-agent` image (`apps/backup-operator/Dockerfile.backup-agent`) built `FROM deluxebear/postgres:17` with the `backup-operator` binary added, so it has the same pgBackRest and PostgreSQL binaries as the database. It runs as the `postgres` user (UID 100), mounts the data volume at the same path as `db`, the socket volume, `backup-config`, and its own state volume, and runs `backup-operator --mode=agent --agent-runtime=docker`. It joins the management network to reach the repository and the Operator's gRPC listener, and in stage 3.3 the proxy network to reach Docker. It stays behind a `backup-agent` profile until it is enrolled (stage 3.2).
- **pgBackRest binary**: the image's `/usr/bin/pgbackrest` is a wrapper that drops `--config` and switches to the `pgbackrest` user with `sudo`. The Agent and `archive_command` call `/usr/lib/pgbackrest/bin/pgbackrest.real` directly as `postgres`, as the Kubernetes runtime already does.
- **`fleet-docker-proxy-backup`** (stage 3.3): the Phase 1 proxy (`fleet-docker-proxy`) with a new `backup` policy: `GET /containers/{id}/json` for project containers, and `start`, `stop`, `restart` for the `db`, `db-validation`, and fence services only. No create, delete, pull, exec, or network changes. The Agent never mounts the Docker socket.

### 4.3 Write fence

`compose-fence`, installed as `/usr/local/bin/backup-fence` in the Agent image, implements the seven entry points by stopping and starting containers through the backup proxy. The containers of each entry point come from `BACKUP_FENCE_<ENTRY_POINT>` variables; every entry point needs at least one, and a container may serve only one. `status` reports `blocked` only when every container of the entry point is stopped.

The fence lifecycle around a restore:

1. The Agent closes the fence (stops the containers) and drains client backends before stopping `db`.
2. After cut-over, the fence is **suspended**: every entry point reopens, but the handle stays durable, including across Agent restarts.
3. A rollback within the window closes the same handle again, rolls back, and releases it.
4. When the window ends, the Agent deletes the quarantined PGDATA and releases the suspended handle. A rollback requested after the window is refused before the fence is touched.

| Entry point       | Containers                                                                                                                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kong-data-plane` | `kong` (Envoy or Kong)                                                                                                                                                                                   |
| `supavisor`       | `supavisor`                                                                                                                                                                                              |
| `auth`            | `auth`                                                                                                                                                                                                   |
| `storage`         | `storage`                                                                                                                                                                                                |
| `realtime`        | `realtime`                                                                                                                                                                                               |
| `background-jobs` | `functions`                                                                                                                                                                                              |
| `direct-postgres` | `rest`, `meta`, and other in-stack PostgreSQL clients. Clients on the published DB port are ended by the engine's writer drain, and the database is stopped for the restore itself. See open question 2. |

### 4.4 Data volume layout migration

New stacks start with the new layout. An existing stack migrates once, when backups are enabled:

1. Record the system identifier and stop `db` (the stack is unavailable for the duration, typically seconds).
2. A one-shot `db-layout-migrate` service mounts the volume, moves every top-level entry into a new `data/` directory with the same owner and mode, and writes a marker file. It is idempotent: with the marker present it does nothing; with a partial move it completes it.
3. Start `db` with the backup overlay and verify the system identifier is unchanged.

Rollback before backups are enabled: run the same service with `MIGRATE_DIRECTION=rollback` while `db` is stopped, and drop the overlay. `docker/fleet-managed/scripts/enable-backups.sh` runs the migration only when the marker is missing, so a repeated run does not stop `db` again. The migration refuses a volume that is neither empty nor a PGDATA directory, and stops if an entry would be overwritten.

### 4.5 Repository

- The control plane gets a `backup-repository` service (RustFS) on the control network, plus the management network so stacks can reach it. It publishes no host port.
- pgBackRest uses S3 over HTTPS only, so the repository serves TLS with a certificate issued from the management CA (`docker/self-platform/scripts/generate-backup-repository-tls.sh`). pgBackRest verifies it with that CA.
- Enabling backups for a project creates a bucket (`fleet-backup-<ref>`), a policy limited to that bucket, and a user with only that policy. RustFS enforces it: the user gets `AccessDenied` for other buckets.
- `pgbackrest.conf` uses `repo1-type=s3`, path-style URIs, `repo1-cipher-type=aes-256-cbc` with a per-project passphrase, and `repo1-retention-full=2`. The file holds secrets, so it is written with mode 0600 under the gitignored `docker/fleet-managed/state/<ref>/backup` and copied into the `backup-config` volume.

### 4.6 Operator changes

1. **Agent listener.** The control-plane Compose file configures `BACKUP_OPERATOR_AGENT_GRPC_LISTEN` on port 9443 with a server certificate and client CA from a separate backup Agent CA (`docker/self-platform/scripts/generate-backup-agent-trust.sh`), so a Fleet Agent certificate cannot authenticate. The Operator joins the management network with the alias `backup-operator`.
2. **Cluster registrations.** `BACKUP_OPERATOR_CLUSTER_DIR` holds one 0600 JSON file per cluster with its project, target, node, Agent ID, certificate fingerprint, system identifier, data domain, stanza, pgBackRest paths, and repository identity. At startup the Operator enrolls each Agent, registers the repository and the cluster, and routes backups, PITR, maintenance, and restores for it. Duplicate targets, nodes, Agents, or stanzas are refused. A new registration takes effect when the Operator is recreated, which `enable-backups.sh` does. A copy step (`backup-operator-config-init`) delivers the files and the server certificate to the Operator user; the CA key stays on the host.
3. **Observation task.** `single-primary-pgbackrest.maintenance.observe` runs on the Agent and returns typed evidence: the system identifier, timeline, recovery state, archive settings and archiver health, `pgbackrest info` JSON, the WAL segments listed with `pgbackrest repo-ls`, and the free bytes next to PGDATA. A coordinator requests it every 5 minutes per cluster (skipping clusters with one already queued) and prunes finished observation jobs after 24 hours, keeping the newest. Discovery, PITR status, and recoverability use evidence up to 15 minutes old. Restore planning needs evidence under 2 minutes old and requests a new observation, waiting up to 30 seconds. Recoverability also requests one when the newest backup finished after the latest observation. Freshness is measured from when the Operator received the evidence, not the Agent's clock.
4. **Quarantine cleanup.** The quarantine records live in the Agent's own recovery store, next to the data, so the Agent cleans them itself: a worker deletes quarantined PGDATA whose rollback window has ended (never the live PGDATA) and records the result. No Operator task is needed.
5. **Docker restore drill.** The Docker runtime reuses the systemd drill runner: restore into the drill workspace and run the validation harness inside the Agent container. The harness, `drill-validator`, starts the restored PGDATA with no TCP listener, archiving off, and read-only transactions; waits for recovery to finish; checks the system identifier; reads every database that accepts connections; and checks that the last replayed transaction is not after the target. Drills restore with a separate `drill.conf` whose repository user can only read the bucket, and recover along the database's current timeline. The Operator schedules them for registered clusters when `BACKUP_OPERATOR_RESTORE_DRILL_ENABLED` is set.

### 4.7 Drill workspace

The workspace must be on a different filesystem from PGDATA. Supported setups:

- **Production:** bind-mount a directory on a separate disk.
- **Local acceptance:** a `tmpfs` mount sized for the test database. It has its own device, so the existing safety check passes without being relaxed.

The device check is not weakened.

### 4.8 Enrollment and bootstrap

`enable-backups.sh <project> -- <compose arguments>` performs, in order:

1. `pgbackrest.conf`, and the backup settings in the project env file.
2. The bucket and credentials.
3. The layout migration.
4. The stanza.
5. WAL archiving.
6. A check and a first full backup.
7. An Agent client certificate from the backup Agent CA, and the cluster registration file. The Operator is recreated to load it.
8. The validation container (created, not started), the backup Docker proxy, and the Agent.

Every step is idempotent. Because it signs the certificate and recreates the Operator, the script runs on the control-plane host; remote stacks need the certificate and registration delivered another way (open question 7).

After that, the `backup-operator` domain answers for the project and Studio shows it as available.

### 4.9 Studio

Studio already routes, authorizes, and renders backups in the Fleet profile, so changes should be small. The work is to verify the Backups, PITR, and restore pages against a live Operator and fix what the live run finds, the same way Phase 1 and 2 were accepted.

## 5. Security boundaries

- The Agent has no Docker socket. The backup proxy allows only start, stop, restart, and inspect, on the allowlisted containers of its own Compose project.
- Restore tasks carry only a confirmed plan; containers, volume, paths, stanza, and repository are enrollment-time values, as the Docker runtime already enforces.
- Repository credentials and the cipher passphrase live only in the project's `pgbackrest.conf` (0600, read-only mount) and never in task payloads, logs, or Studio responses.
- Each Agent has its own client certificate whose fingerprint is pinned in its enrollment; an Agent can only receive tasks for its own cluster.
- Destructive steps keep every existing gate: plan hash, AAL2, fresh evidence, write fence, isolated validation, and the rollback window.

## 6. Plan

Each stage ends with unit tests and a live check on the local environment.

| Stage | Work                                                                                                       | Done when                                                                                                                                    | Size        |
| ----- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 3.1   | Agent image, backup overlay, RustFS, layout migration, `enable-backups.sh` steps 1–3                       | `project-d` runs on the new layout, and `pgbackrest stanza-create`, `check`, and a full backup succeed from the Agent container              | 1 week      |
| 3.2   | Operator: Agent listener, cluster registrations, observation task                                          | A scheduled full backup and PITR enable run through the Operator for `project-d`; discovery and the recovery window come from Agent evidence | 1.5–2 weeks |
| 3.3   | Compose write fence, quarantine cleanup task, timeline history, in-place PITR restore through the Operator | A PITR restore of `project-d` to a timestamp succeeds with the fence engaged and released, and rollback works within the window              | 1 week      |
| 3.4   | Docker restore drill with a `tmpfs` workspace                                                              | A drill succeeds and confidence becomes `drill-verified`                                                                                     | 0.5–1 week  |
| 3.5   | Studio live acceptance, E2E script, evidence                                                               | The done criteria in section 1 are met                                                                                                       | 0.5 week    |

Total: about 4.5–5.5 weeks, above the roadmap's 3–4 weeks because of option B.

## 7. Risks and open questions

1. **Option A or B.** Decided: option B (section 3).
2. **`direct-postgres` fence.** Stopping in-stack clients covers the stack. Clients connecting from outside through the published DB port are ended by the writer drain, and the database itself is stopped for the restore. A stricter gate (for example `pg_hba` rejection) can follow if the release requires it.
3. **RustFS bucket-scoped credentials.** Resolved in stage 3.1: a bucket policy attached to a per-project user is enforced.
4. **Layout migration downtime.** Proportional to file count, not data size (a rename within one filesystem), but the stack is down while it runs.
5. **pgsodium and Vault keys.** A restored database needs the same root key. The project's key lives outside PGDATA (`db-config` volume), so an in-place restore keeps it. A restore to a new stack must copy it; this is out of scope for Phase 3 and documented as a limitation.
6. **Capacity.** In-place restore keeps the quarantined PGDATA until the rollback window ends, so the volume needs room for two copies. The Operator's capacity check already enforces this using the Agent-reported free bytes.
7. **Remote stacks.** `enable-backups.sh` assumes the stack and the control plane share a host. A stack on another host needs the Agent certificate, the registration file, and the Operator restart split into a control-plane step.
8. **Timeline history.** Resolved in stage 3.3: observations read each history file with `pgbackrest repo-get`, so the recovery window follows a timeline switch.
9. **Destructive lease and rollback window.** The Operator's destructive lease lasts 15 minutes, but the default rollback window is an hour. The Agent therefore refuses a new restore while a previous restore's quarantine exists. Aligning the lease with the window is a follow-up.

## 8. Verification

`docker/self-platform/scripts/verify-compose-backups.sh <ref> -- <stack Compose arguments>` runs against a stack that already ran `enable-backups.sh`:

1. Check that discovery and PITR status come from the Agent.
2. Take a full backup and write fixture rows before and after a target time.
3. Run an on-demand isolated restore drill and require `drill-verified`.
4. Restore to the target time; require only the earlier row and the services running again.
5. Roll back; require both rows and the services.
6. Require the backup proxy to refuse another project's container and a service outside the fence, and the drill credentials to fail writing to the bucket.

It drops the fixture table at the end. It runs against an existing stack rather than a disposable two-stack environment; Agent-to-cluster isolation between projects is covered by the enrollment and dispatch unit tests. Evidence goes to `docs/self-hosted-parity/qa-evidence/`.

## 9. Progress

### Stage 3.1 (done 2026-10-12)

On the local environment, `enable-backups.sh project-d` migrated the data volume (system identifier unchanged), created the bucket, user, and stanza, turned on archiving, and took a full backup from the Agent container: 645.6 MB of data, 90.1 MB stored after compression and encryption. A second run changed nothing and did not restart `db`. The layout migration was also tested on scratch volumes: forward, repeated, rollback, a partial earlier run, a conflicting entry (refused), a non-PGDATA volume (refused), and an empty volume.

Findings that changed the design:

- The image's pgBackRest wrapper drops `--config` and runs as another user, so the real binary is used.
- pgBackRest needs HTTPS for S3, so the repository serves TLS from the management CA.
- Backups need WAL archiving, so it is turned on when backups are enabled rather than only for PITR.
- The configuration is copied into a volume owned by UID 100 instead of bind-mounted.

### Stage 3.2 (done 2026-10-12)

The Operator on the control plane now serves `project-d` from its Agent's observations. On the local environment:

- The Agent connected over mTLS, and the first observation arrived within seconds of the Operator starting.
- `GET /v1/clusters/project-d` reported the topology, primary, and repository from the observation, with no blockers. `GET .../pitr` reported archiving enabled and healthy.
- `POST .../pitr/enable` ran through the Agent: it restarted `db` through the backup proxy, checked the stanza, switched WAL, and took a full backup.
- A scheduled full backup ran from the policy, recorded its manifest, and the recovery window became `inferred` once the next observation listed its WAL.

Work pulled forward from stage 3.3, because the Docker runtime needs it to start and PITR enable restarts `db`: the `backup` proxy policy and `fleet-docker-proxy-backup` service, the `db-validation` container, and a write fence helper that refuses to block. Restores therefore stop before they change anything until stage 3.3 replaces the helper.

Defects found and fixed during the live run:

- The Operator's runtime workers start only when a local observer is configured, so tasks for registered clusters were never dispatched. Registered clusters now provide one.
- Docker reports a restarted container as running before PostgreSQL accepts connections, so PITR enable failed at `stanza-create`. The Docker runtime now waits for the database after a restart.
- Enabling PITR and saving a policy in Studio wrote two policies with different IDs, and the scheduler ran both. Both now write the cluster's existing policy.
- Studio marked the shared `backup-operator` domain unavailable for every project when one project got an application error, such as a 404 for a cluster without backups. Only network errors, 401, 403, and 5xx responses do now.
- An idle database never completed a WAL segment, so the recovery window stopped at the last backup. `enable-backups.sh` sets `archive_timeout` to 120 seconds.
- The Agent's reconnect loop and the outbox dispatcher dropped errors silently; both log them now.

### Stage 3.3 (done 2026-10-12)

In-place PITR restore and rollback run through the Operator on `project-d`. A fixture table had one row written before the target time and one after. Each restore left only the earlier row, on a new timeline, with every service back up after cut-over; each rollback brought both rows back on the original timeline. The cycle ran four times, and every restore chose a new timeline ID (2, 3, 4, 5). With the rollback window set to two minutes, the Agent deleted the quarantine after the window, and a later rollback was refused without stopping any service.

Defects found and fixed during the live run:

- Restore dispatch failed on the PostgreSQL control store: a boolean column was written as an integer. A PostgreSQL integration test now covers restore dispatch and the observation queries.
- A failed dispatch kept the destructive lease for its whole 15-minute window, blocking retries. The lease is now released when the dispatch does not commit.
- The engine never released the write fence, so the stack stayed down after a successful restore. The fence is now suspended after cut-over and released after rollback or when the window ends.
- A rollback requested after the window closed the fence before discovering the window had ended, leaving the stack down. The window is checked first.
- The validation instance ran with archiving off, so the new timeline's history file never reached the repository and the next restore reused timeline 2, colliding with the first restore's WAL. The abandoned segment was removed from the local repository by hand.
- Recovery followed the newest timeline in the archive. After a rollback that is an abandoned branch, so recovery now follows the timeline the database was on when the restore was planned (`--target-timeline`).
- Restore planning could reuse an observation taken before the target time or before the last restore or rollback. Planning now always waits for a new observation, and status views ignore observations older than the last restore or rollback.

### Stage 3.4 (done 2026-10-12)

A scheduled drill on `project-d` restored into a 2 GB `tmpfs` workspace, recovered along timeline 5 to five minutes before the drill, stopped before the first transaction after the target, and promoted to a timeline it never archived. The validator read all eight databases. The workspace was removed afterwards, and the project's recovery confidence became `drill-verified`. The drill user's write to the bucket was refused with `AccessDenied`.

Notes:

- A restored PGDATA carries the `ALTER SYSTEM` settings of its backup. `archive_timeout` was set after the backup used here, so it is missing after a restore until `enable-backups.sh` runs again. Settings the stack needs should be applied after a restore, not only at enable time; this belongs with the Studio acceptance in stage 3.5.
- Validator logs (`<workspace>.log`, `<workspace>.postgres.log`) stay in the workspace root after each drill for diagnosis.

### Stage 3.5 (done 2026-10-12)

`verify-compose-backups.sh project-d` passed on its first run, and Studio showed the backups, policy, drill, and recovery window for `project-d` and started a backup and a restore plan. Evidence: [qa-evidence/2026-10-12-phase3-compose-backups](./qa-evidence/2026-10-12-phase3-compose-backups/README.md).

Defects found and fixed:

- In the Fleet profile Studio read the backup status from a row the old co-located Operator published in the project database, so the page said backups were not configured. Studio now builds the status from the Operator's cluster discovery and backup policy; a project without backups shows as not configured, and a cluster without a recent observation as degraded.
- On-demand drills (`POST .../maintenance` with `restore-drill`) sent no target, so the Agent refused them. The Operator now derives the target from the same observations as scheduled drills.
- The backups API reported every reason as a blocker, so a drill that predated the newest backup made Studio show PITR as blocked although the window was usable. Reasons block only when no window exists; otherwise they are returned as `notes`.
- A restore plan listed no affected nodes; it now names the target node.
- `archive_timeout` moved from `ALTER SYSTEM` to the overlay's `db` command, so a restore cannot drop it.

Known limits:

- Recovery confidence follows the newest backup, so each new full backup returns it to `inferred` until the next drill (daily by default).
- `enable-backups.sh` assumes the stack and the control plane share a host (open question 7).
- The Operator's destructive lease is shorter than the rollback window (open question 9); the Agent guards the gap.
