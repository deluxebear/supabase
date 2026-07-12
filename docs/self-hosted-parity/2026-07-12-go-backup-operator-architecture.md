# Go Backup Operator Architecture for Self-Hosted Supabase

- Date: 2026-07-12
- Status: engineering-reviewed implementation plan
- Scope: single-primary and primary/standby PostgreSQL clusters on bare metal, Docker Compose, and Kubernetes
- Backup providers: pgBackRest for bare metal/Compose/generic Kubernetes; provider-native recovery for managed Kubernetes operators
- Control plane: Supabase Studio self-platform
- Language: Go 1.24 or later

## 1. Executive summary

The self-hosted Studio currently observes operator-published pgBackRest state but does not enable backups, run backups, or restore a database. This design adds a small Go subsystem with two deployable roles:

1. **Backup Operator**: the control-plane service that owns desired state, topology, jobs, locks, policy, audit records, and the Studio-facing API.
2. **Backup Agent**: a node-local executor that performs a constrained set of PostgreSQL and pgBackRest actions on a database host or Kubernetes workload.

The same Go binary supports both roles. A single-node installation may run them in one process. A multi-node installation runs one Operator and one Agent per database node. Kubernetes may replace persistent node Agents with short-lived Jobs behind the same task protocol.

The Operator's authoritative state must live **outside every managed PostgreSQL recovery domain**. The current all-in-one self-platform database is inside the Supabase PostgreSQL cluster and therefore cannot hold restore jobs, leases, confirmation records, audit history, or repository secrets for that same cluster. Production uses an independent control PostgreSQL. Lightweight single-host mode may use SQLite stored outside `PGDATA` and outside the database volume.

Recovery is not one universal filesystem operation:

- bare metal, Compose, and unmanaged PostgreSQL workloads use an `InPlaceRestore` strategy;
- Self-managed Kubernetes uses a `ReplacementWorkloadRestore` strategy that creates a new StatefulSet/PVC set with the customized Supabase PostgreSQL image, validates it, switches traffic, and quarantines the old workload. Managed database operators are optional adapters.

The design deliberately separates stable orchestration from environment-specific mechanics:

```text
Studio / self-platform API
          |
          v
Go Backup Operator
  - cluster topology
  - desired configuration
  - durable jobs and audit
  - cluster/repository locks
  - restore state machine
          |
          v
Agent transport (mTLS, outbound stream, or local in-process)
          |
          v
Recovery strategy + topology + backup providers
  - bare metal/systemd
  - Docker Compose
  - self-managed Kubernetes or optional managed PostgreSQL operator
  - Patroni or static primary/standby in the core distribution
  - customized-image pgBackRest by default
```

The first production milestone should ship the complete domain model and driver boundaries, then enable deployment modes in controlled stages. Cross-environment behavior is one product, not separate implementations.

## 2. Problem statement

### 2.1 Current behavior

The repository already provides:

- `apps/studio/lib/api/self-platform/backups.ts`, which reads `_supabase_platform.pgbackrest_info` from a registered project database.
- `GET /platform/database/{ref}/backups`, which maps published pgBackRest information to the upstream Studio response.
- a self-platform UI that displays scheduled physical backups and an approximate PITR window.
- an operator runbook for configuring pgBackRest and publishing status.
- a hard self-platform guard that disables Studio-triggered PITR restore.

The repository does not currently provide:

- a service that owns backup configuration;
- an API that enables or disables WAL archiving;
- durable backup and restore jobs;
- database runtime control during restore;
- primary/standby topology coordination;
- automatic standby rebuild after PITR;
- a safe remote executor for bare-metal or Compose hosts;
- Kubernetes-native execution;
- end-to-end progress, cancellation, audit, and recovery semantics.

### 2.2 Target behavior

An authorized platform administrator can use Studio to:

- register a PostgreSQL cluster and discover its topology;
- configure a pgBackRest repository and retention policy;
- enable PITR safely;
- run and monitor full, differential, and incremental backups;
- validate a requested recovery target before downtime begins;
- execute an in-place PITR operation against the whole cluster;
- automatically isolate and rebuild all standbys after the restored primary is healthy;
- see per-node progress, warnings, and actionable failure information;
- use the same workflow on bare metal, Docker Compose, and Kubernetes.

### 2.3 Success criteria

The feature is complete when all of the following are true:

1. One API and one job model cover all supported deployment types.
2. No Studio or Operator process requires direct shell access to database hosts.
3. Every privileged host action is an enumerated Agent operation, never arbitrary shell input.
4. A restore cannot run concurrently with a backup, failover, topology change, or another restore on the same cluster or repository.
5. A PITR operation on a primary/standby cluster either restores the primary and rebuilds every required standby, or stops in an explicit recoverable/manual-intervention state.
6. Operator and Agent restarts do not lose or duplicate a job.
7. The system can prove which user requested an action, which nodes executed it, which commands were selected, and what changed.
8. Existing read-only `pgbackrest_info` consumers remain compatible during migration.
9. The authoritative job store remains available and is never rolled back when a managed cluster is restored.
10. Every restore capability is gated on a concrete, verifiable write-fencing implementation for that deployment.

## 3. Scope

### 3.1 Included

- PostgreSQL single-primary clusters.
- PostgreSQL clusters with one primary and multiple streaming-replication standbys.
- Static/systemd, Patroni, Docker Compose, and self-managed Kubernetes integration; managed operators are optional adapters.
- pgBackRest repository types supported by pgBackRest, initially S3-compatible and POSIX.
- Optional provider-native backup/recovery adapters for managed Kubernetes operators when pgBackRest is not their supported recovery path.
- PITR enablement, health checks, scheduled backups, manual backups, in-place PITR, and replacement-workload PITR.
- Automatic standby recreation after PITR.
- Studio integration through self-platform API routes.
- RBAC, mTLS/service authentication, audit, idempotency, locking, and metrics.
- An upgrade path from the existing status-table publication design.

### 3.2 Explicitly excluded from the first implementation

- Logical `pg_dump` backup orchestration.
- Cross-major-version PostgreSQL restore.
- Per-logical-database physical restore. pgBackRest operates on a PostgreSQL instance.
- Cross-cloud repository replication as a first-class feature.
- Automatic disaster-recovery promotion across independent regions.
- General-purpose remote command execution.
- Replacing Patroni or any installed managed PostgreSQL operator.
- Restoring into a separately registered Supabase project as a user-facing clone operation. Kubernetes replacement-workload recovery inside the same registered project is included because it is the safe implementation of recovery, not a new project feature.

These exclusions do not alter the driver and job contracts needed to add the features later.

## 4. Design principles

1. **One job/audit model, multiple recovery strategies.** Do not force filesystem restore and controller-managed replacement into the same interface.
2. **Operator decides; Agent executes.** Agents never elect a primary, choose a target, or independently start a restore.
3. **Fail closed for destructive work.** Unknown topology, unreachable nodes, stale leases, or incomplete repository metadata block restore.
4. **At-least-once delivery, reconciled effects.** Exactly-once side effects are not promised. Steps use idempotency keys, repository facts, local execution locks, and postcondition checks.
5. **Durable state before side effects.** The next step is committed before it is dispatched.
6. **No user-provided shell.** API values are parsed into typed operations and validated again by the Agent.
7. **Cluster-level restore semantics.** A PITR restore invalidates old standbys; they must be isolated and rebuilt.
8. **External HA systems remain authoritative.** The Operator coordinates with them instead of bypassing them.
9. **Small operational footprint.** One statically linked binary, PostgreSQL persistence, no mandatory message broker.
10. **Observable degradation.** Partial capability is displayed explicitly instead of being presented as success.
11. **Control state survives the operation.** Jobs, leases, audit events, secrets, and confirmations never live in the database cluster they control.
12. **No automatic takeover of uncertain destructive work.** A lost executor enters an orphaned/manual state until postconditions prove what happened.

## 5. Deployment topology

### 5.1 Recommended production topology

```text
                    independent control PostgreSQL
                         - configuration
                         - jobs / steps
                         - leases / locks
                         - audit log
                                  ^
                                  |
Studio ---> self-platform API ---> Backup Operator
                                      |
                              mTLS task streams
                 +--------------------+--------------------+
                 |                    |                    |
          Agent: primary       Agent: standby-1     Agent: standby-2
                 |                    |                    |
          PostgreSQL/pgBR      PostgreSQL/pgBR      PostgreSQL/pgBR
```

The Operator and its control store must be deployed outside every managed cluster's failure and recovery domain. Agents run near the resources they control. The current self-platform `_platform` database may still provide identity/RBAC input and compatibility projections, but it is not authoritative for backup execution.

### 5.2 Lightweight single-host mode

For a single bare-metal or Compose host, one binary may run with `--mode=all`:

```text
backup-operator --mode=all
  - local Operator
  - embedded Agent
  - local SQLite control store outside PGDATA/database volumes
  - systemd or Compose runtime driver
```

The process still uses the same internal Agent protocol and typed operations. This is a packaging optimization, not a separate architecture. SQLite must be backed up separately and must remain mounted while PostgreSQL is stopped or restored.

### 5.3 Bare metal

- Operator: central platform host with independent control PostgreSQL, or the database host with external SQLite for a small installation.
- Agent: systemd service on every PostgreSQL node.
- Runtime driver: systemd and local process/filesystem integration.
- HA driver: Patroni when present, otherwise static topology plus PostgreSQL probes.
- Scheduling: Operator scheduler; an optional systemd timer may invoke a local Agent endpoint as a fallback.

### 5.4 Docker Compose

- Operator: separate service in the platform Compose project.
- Agent: host systemd service is preferred because restore must survive DB container removal and recreation.
- Alternative for controlled appliances: privileged sidecar with narrowly mounted paths and a restricted container-runtime proxy.
- Runtime driver: Docker Engine API plus a Compose identity descriptor. Do not parse or execute arbitrary Compose commands from request input.
- DB container retains `pgbackrest` for `archive-push`; the Agent may use a dedicated restore image for offline operations.

Directly mounting `/var/run/docker.sock` into an Internet-reachable API service is prohibited. If a containerized Agent needs Docker access, place a policy-limited socket proxy between it and the daemon.

### 5.5 Kubernetes

Two implementations share the same driver contract:

1. **Native controller mode:** the Operator uses Kubernetes APIs and launches dedicated backup/restore Jobs with a restricted ServiceAccount.
2. **External database mode:** Agents run on database VMs and Kubernetes only hosts the control plane.

For explicitly self-managed StatefulSets, the default recovery strategy is replacement-workload recovery with the customized image's built-in pgBackRest implementation. In-place PVC restore is not advertised by default.

The recovery strategy must:

1. create a replacement StatefulSet identity and new PVC set;
2. use the registered pgBackRest repository, stanza, database history, and target;
3. wait for the recovered primary and rebuild requested replicas;
4. validate PostgreSQL and Supabase services against an isolated endpoint;
5. switch the project connection/Service only after validation;
6. retain the old StatefulSet and PVCs as quarantine until the rollback window expires.

If a recognized managed operator owns the workload, the generic provider fails closed. A separately installed optional adapter must use the owning controller's supported replacement workflow and must never edit its PVCs behind the controller.

Kubernetes Lease may supplement, but not replace, the Operator's durable control-store lock. The Kubernetes controller remains authoritative for Pod/PVC lifecycle.

## 6. Repository layout

Introduce a new top-level Go workspace:

```text
apps/backup-operator/
  go.mod
  cmd/backup-operator/main.go
  cmd/backupctl/main.go
  internal/
    api/                 # HTTP handlers and generated OpenAPI bindings
    app/                 # use cases and transaction boundaries
    auth/                # service auth, claims, authorization context
    domain/              # cluster, node, policy, job, step, event models
    orchestration/       # state machines, reconciliation, and orphan handling
    strategies/
      restore/inplace/
      restore/replacement/
    scheduler/           # due-policy scanning and job creation
    store/               # ControlStore interface, PostgreSQL and SQLite stores
    transport/           # Agent streams and task/result envelopes
    agent/               # Agent service and operation registry
    drivers/
      backup/pgbackrest/
      backup/cloudnativepg/
      fence/supabase/
      runtime/systemd/
      runtime/docker/
      runtime/kubernetes/
      ha/static/
      ha/patroni/
      topology/cloudnativepg/
      storage/posix/
      storage/s3/
    observability/
    config/
  migrations/
  api/openapi.yaml
  deploy/
    systemd/
    compose/
    kubernetes/
  test/
    integration/
    e2e/
```

Avoid a multi-module Go workspace initially. A single `go.mod` keeps builds, dependency updates, and generated API types simple.

## 7. Component responsibilities

### 7.1 Studio

Studio remains an unprivileged user interface. It:

- displays cluster backup configuration and actual health;
- submits typed API requests through self-platform routes;
- polls or subscribes to durable job events;
- renders impact previews and requires destructive confirmation;
- never receives repository secrets or Agent credentials;
- never executes host or Kubernetes commands.

### 7.2 Self-platform API adapter

Self-platform routes:

- authenticate the platform user;
- use the existing project/org RBAC context;
- map `projectRef` to `cluster_id`;
- mint a short-lived internal service assertion or call the Operator over a private network;
- translate Operator errors into stable Studio responses.

The Operator must still authorize the service assertion and requested scope. Network reachability is not authorization.

### 7.3 Backup Operator

The Operator owns:

- cluster and node registration;
- desired backup policies;
- topology snapshots and validation;
- job and step persistence;
- scheduling;
- cluster and repository leases;
- restore plans and confirmation tokens;
- task dispatch;
- retries, reconciliation, and compensation;
- audit events;
- status projection for Studio and the existing `pgbackrest_info` view.

The Operator refuses to register a managed cluster when its configured control store resolves to that same PostgreSQL system identifier. A production deployment must also prove that the control store does not share the managed cluster's data volume or lifecycle.

### 7.4 Backup Agent

The Agent owns only local execution:

- inspect PostgreSQL identity and recovery state;
- inspect pgBackRest configuration and repository metadata;
- render configuration from a validated typed request;
- atomically install approved configuration files;
- run approved pgBackRest operations;
- start, stop, restart, and probe PostgreSQL through its runtime driver;
- quarantine or initialize a configured data directory;
- stream logs and progress;
- enforce local allowlists, timeouts, and concurrency limits.
- hold a durable node-local exclusive execution lock for every destructive operation;
- enter `orphaned_execution` when control-plane authority is lost after a destructive command starts;
- refuse a second destructive command until an administrator or reconciler resolves the first command's postconditions.

The Agent must reject a request when its cluster ID, node ID, system identifier, expected role, data directory, stanza, or repository fingerprint does not match its local enrollment.

### 7.5 `backupctl`

`backupctl` provides an operational escape hatch and automation surface:

- inspect clusters and jobs;
- validate configuration;
- create a backup or restore plan;
- confirm an approved restore;
- retry a recoverable step;
- place a cluster in or out of maintenance mode;
- export an audit bundle.

It uses the Operator API. It is not a wrapper for arbitrary local shell commands.

## 8. Domain model

### 8.1 Cluster

```go
type Cluster struct {
    ID                 uuid.UUID
    ProjectRef         string
    OrganizationID     string
    Name               string
    DeploymentKind     DeploymentKind // baremetal, compose, kubernetes
    RuntimeProvider    string
    TopologyProvider   string
    BackupProvider     string          // customized-image pgbackrest by default
    RecoveryStrategy   string          // inplace, replacement-workload, optional managed-replacement
    WriteFenceProvider string
    ExpectedSystemID   string
    DesiredGeneration  int64
    ObservedGeneration int64
    State              ClusterState
    MaintenanceMode    bool
    CreatedAt          time.Time
    UpdatedAt          time.Time
}
```

`BackupProvider` defaults to the pgBackRest already packaged in the customized Supabase PostgreSQL image. Optional managed-operator providers are separate adapters. `RecoveryStrategy` selects the orchestration shape and is not inferred from the runtime provider.

### 8.2 Node

```go
type Node struct {
    ID              uuid.UUID
    ClusterID       uuid.UUID
    Name            string
    AgentID         string
    DesiredRole     NodeRole // primary, standby, backup-standby
    ObservedRole    NodeRole
    EndpointMode    string   // outbound-stream, inbound-mtls, local, k8s-job
    RuntimeMetadata json.RawMessage
    Healthy         bool
    Reachable       bool
    Timeline        uint64
    ReplayLSN       string
    ReplayLagBytes  int64
    LastSeenAt      time.Time
}
```

### 8.3 Backup policy

```go
type BackupPolicy struct {
    ID                 uuid.UUID
    ClusterID          uuid.UUID
    Enabled            bool
    Stanza             string
    RepositoryID       uuid.UUID
    FullSchedule       string
    DifferentialSchedule string
    IncrementalSchedule  string
    RetentionFull      int
    RetentionDiff      int
    ArchiveAsync       bool
    BackupFrom         string // primary or designated-standby
    MaxStandbyLagBytes int64
    Generation         int64
}
```

### 8.4 Job and step

All long-running work is represented by a durable job:

```go
type Job struct {
    ID             uuid.UUID
    ClusterID      uuid.UUID
    Type           JobType
    State          JobState
    RequestedBy    string
    IdempotencyKey string
    PlanHash       string
    Input          json.RawMessage
    Result         json.RawMessage
    ErrorCode      string
    ErrorMessage   string
    CreatedAt      time.Time
    StartedAt      *time.Time
    FinishedAt     *time.Time
}

type Step struct {
    ID             uuid.UUID
    JobID          uuid.UUID
    NodeID         *uuid.UUID
    Name           string
    Sequence       int
    State          StepState
    Attempt        int
    DispatchToken  string
    FencingToken   int64
    NonTakeover    bool
    Preconditions  json.RawMessage
    Result         json.RawMessage
    LastHeartbeat  *time.Time
}
```

### 8.5 Job states

```text
draft
  -> awaiting_confirmation
  -> queued
  -> acquiring_lock
  -> validating
  -> running
  -> verifying
  -> succeeded

Any active state may enter:
  -> cancelling -> cancelled
  -> compensating -> failed
  -> orphaned_execution
  -> manual_intervention
```

`orphaned_execution` means a destructive command may still be running or may have completed without a durable result. No new owner may replay or replace it automatically. `manual_intervention` is a terminal operational state but not data loss. Both states include exact recovery instructions and retain the cluster/node lock until an administrator explicitly resolves it from observed postconditions.

## 9. Persistence model

Use a `ControlStore` that is outside every managed cluster's recovery domain:

- production: an independent PostgreSQL instance/database in a separate lifecycle and data volume;
- lightweight single-host mode: SQLite on the Operator host, outside `PGDATA` and database volumes;
- prohibited: the current all-in-one `_platform` database when it is hosted by the PostgreSQL cluster being managed.

Do not require Redis, Kafka, or a separate message broker for the initial system. PostgreSQL and SQLite implementations must provide the same transaction, lease, idempotency, and audit semantics used by the orchestration layer.

Required tables:

- `clusters`
- `nodes`
- `repositories`
- `backup_policies`
- `jobs`
- `job_steps`
- `task_outbox`
- `task_results`
- `job_events`
- `leases`
- `agent_enrollments`
- `agent_sessions`
- `audit_events`
- `restore_plans`
- `schedule_claims`

Important constraints:

- unique `clusters(project_ref)`;
- unique `repositories(id, fingerprint)` and `backup_policies(repository_id, stanza)`;
- bind every stanza registration to PostgreSQL system identifier, major version, repository fingerprint, and pgBackRest database history ID;
- unique `jobs(cluster_id, idempotency_key)` when the key is non-null;
- one active destructive job per cluster through a partial unique index;
- one active repository-mutating job per repository through a lease row;
- append-only `job_events` and `audit_events`;
- unique task dispatch/result IDs for inbox/outbox delivery;
- optimistic version on mutable desired-state rows;
- encrypted repository secrets using envelope encryption, never plain JSONB.

The PostgreSQL scheduler and workers use `SELECT ... FOR UPDATE SKIP LOCKED`. SQLite single-host mode uses one writer transaction and does not claim horizontal worker support. PostgreSQL advisory locks may optimize local contention but must not be the only durable lock record.

Task dispatch uses a transactional outbox: the step transition and outgoing task are committed together, then a dispatcher sends the task. Results are deduplicated through `task_results`. This closes the crash window between persistence and network dispatch without claiming exactly-once command execution.

`job_events` and `audit_events` require time-based partitioning/retention in PostgreSQL. Audit retention must satisfy policy and be exportable before partition deletion. SQLite mode uses bounded log tables plus periodic archive/export.

## 10. Provider and strategy contracts

Interfaces are capability-oriented and are finalized only after the destructive feasibility spikes in Milestone 0. Providers return typed observations and errors. They do not leak implementation-specific command strings into the orchestration layer.

### 10.1 Backup provider

```go
type BackupExecutionTarget struct {
    Primary     NodeTarget
    Standby     *NodeTarget
    Coordinator ExecutionTarget
    Repository  RepositoryTarget
}

type BackupProvider interface {
    Capabilities(ctx context.Context, cluster ClusterTarget) (BackupCapabilities, error)
    Inspect(ctx context.Context, target BackupExecutionTarget) (BackupInfo, error)
    ValidateConfig(ctx context.Context, target BackupExecutionTarget, cfg BackupConfig) error
    ApplyConfig(ctx context.Context, target BackupExecutionTarget, cfg BackupConfig) (ConfigResult, error)
    Check(ctx context.Context, target BackupExecutionTarget) (CheckResult, error)
    Backup(ctx context.Context, target BackupExecutionTarget, kind BackupKind, jobID uuid.UUID) (BackupResult, error)
}
```

The pgBackRest implementation coordinates primary, optional standby, and repository host as one execution target. It constructs arguments from typed fields, invokes `exec.CommandContext` without a shell, and annotates backups with the job ID when supported so repository facts can reconcile a lost Agent result.

### 10.2 In-place runtime provider

```go
type InPlaceRuntimeProvider interface {
    Inspect(ctx context.Context, node NodeTarget) (RuntimeState, error)
    StopPostgres(ctx context.Context, node NodeTarget) error
    StartPostgres(ctx context.Context, node NodeTarget) error
    RestartPostgres(ctx context.Context, node NodeTarget) error
    WaitHealthy(ctx context.Context, node NodeTarget, deadline time.Time) error
    QuarantineDataDir(ctx context.Context, node NodeTarget, jobID uuid.UUID) (QuarantineRef, error)
    PrepareEmptyDataDir(ctx context.Context, node NodeTarget) error
}
```

Implementations:

- `SystemdRuntime`: fixed unit allowlist, fixed PGDATA enrollment.
- `DockerRuntime`: Engine API, fixed container/volume identity.
- `GenericKubernetesRuntime`: typed client for explicitly self-managed StatefulSets running an allowlisted customized Supabase PostgreSQL image. Replacement recovery always allocates a new PVC.

### 10.3 Topology/HA provider

```go
type TopologyProvider interface {
    Discover(ctx context.Context, cluster ClusterTarget) (Topology, error)
    ValidateStable(ctx context.Context, topology Topology) error
    PauseFailover(ctx context.Context, cluster ClusterTarget) (PauseToken, error)
    ResumeFailover(ctx context.Context, cluster ClusterTarget, token PauseToken) error
    Promote(ctx context.Context, node NodeTarget) error
    RebuildStandby(ctx context.Context, primary NodeTarget, standby NodeTarget) error
}
```

Implementations:

- `StaticHA`: PostgreSQL probes plus explicit topology; suitable for no automatic failover.
- `PatroniHA`: Patroni REST API and DCS-aware pause/resume/reinitialize.
- `ManagedOperatorTopology` is an optional extension point. It is enabled only after positive controller-ownership and image-compatibility detection; the core distribution does not install CloudNativePG, cert-manager, or CNPG-I.

`PatroniTopology` must explicitly model DCS leader identity/history, pause state, member state, synchronous replication, watchdog state, and the distinction between stopping Patroni and stopping PostgreSQL. Patroni pause is maintenance coordination, not a write fence.

### 10.4 Write-fence provider

```go
type WriteFenceProvider interface {
    Capabilities(ctx context.Context, cluster ClusterTarget) (FenceCapabilities, error)
    Engage(ctx context.Context, cluster ClusterTarget, jobID uuid.UUID) (FenceEvidence, error)
    Verify(ctx context.Context, cluster ClusterTarget, evidence FenceEvidence) (FenceEvidence, error)
    Release(ctx context.Context, cluster ClusterTarget, evidence FenceEvidence) error
}
```

The Supabase implementation must cover edge routing, Supavisor/poolers, Auth/Storage/Realtime/background services, direct PostgreSQL clients, active write transactions, and prepared transactions. A deployment without a verifiable direct-connection fence does not advertise restore capability.

### 10.5 Recovery strategy

```go
type RecoveryStrategy interface {
    Capabilities(ctx context.Context, cluster ClusterTarget) (RecoveryCapabilities, error)
    Plan(ctx context.Context, request RestoreRequest) (RestorePlan, error)
    Execute(ctx context.Context, plan RestorePlan, progress ProgressSink) (RestoreResult, error)
    InspectPostconditions(ctx context.Context, plan RestorePlan) (RestorePostconditions, error)
}
```

- `InPlaceRestoreStrategy` composes the pgBackRest provider, runtime provider, topology provider, and write-fence provider.
- `ReplacementWorkloadRestoreStrategy` creates a replacement StatefulSet and new PVC, restores through the customized image's pgBackRest provider, validates an isolated endpoint, and performs an explicit traffic/registry cutover. Optional managed operators use a separate strategy adapter.

### 10.6 Repository provider

The repository abstraction validates reachability, capacity, encryption, and identity. Actual backup and restore remain pgBackRest operations.

```go
type RepositoryProvider interface {
    Fingerprint(ctx context.Context, cfg RepositoryConfig) (string, error)
    CheckAccess(ctx context.Context, cfg RepositoryConfig) error
    EstimateRestoreSpace(ctx context.Context, cfg RepositoryConfig, backup BackupInfo) (int64, error)
}
```

## 11. Agent protocol

### 11.1 Transport modes

Support three transports behind one protocol:

- outbound bidirectional gRPC stream from Agent to Operator, recommended for bare metal and private networks;
- inbound mTLS gRPC for tightly controlled networks;
- in-process transport for `--mode=all`;
- Kubernetes task adapter that turns a task into a Job and maps Job status back to the protocol.

The outbound stream is the default because a database host does not need an inbound management port.

### 11.2 Task envelope

```protobuf
message AgentTask {
  string task_id = 1;
  string job_id = 2;
  string step_id = 3;
  string cluster_id = 4;
  string node_id = 5;
  int64 deadline_unix = 6;
  string idempotency_key = 7;
  Preconditions preconditions = 8;
  int64 fencing_token = 9;
  bool non_takeover = 10;
  oneof operation {
    InspectNode inspect_node = 20;
    ApplyPgBackRestConfig apply_config = 21;
    RunPgBackRestCheck run_check = 22;
    RunBackup run_backup = 23;
    StopPostgres stop_postgres = 24;
    StartPostgres start_postgres = 25;
    QuarantineDataDir quarantine_data_dir = 26;
    RunRestore run_restore = 27;
    RebuildStandby rebuild_standby = 28;
  }
}
```

The Agent persists task IDs, fencing tokens, command identity, process identity, progress, and final results in SQLite stored outside `PGDATA`. Re-delivery returns the existing result or resumes only operations explicitly marked resumable.

Before starting a destructive operation, the Agent acquires a node-local OS/file lock and SQLite execution record. Once the external command begins, lease loss or stream loss does not authorize another execution. The Agent attempts to finish or safely stop according to the operation's cancellation policy, marks the task `orphaned_execution`, and requires postcondition reconciliation before releasing its local lock.

Fencing tokens prevent stale tasks from starting; they cannot stop a command already running. The protocol and documentation must not describe them as exactly-once enforcement.

### 11.3 Heartbeats

- Agent session heartbeat: every 10 seconds.
- Running step heartbeat: every 5 seconds.
- Operator marks a session stale after 30 seconds.
- A lost Agent during a destructive step does not cause automatic replay until the Operator re-inspects postconditions.
- A destructive command never transfers ownership solely because its lease or heartbeat expired.
- Log/progress streams use bounded buffers and backpressure; complete command logs are stored locally or in configured object storage rather than unbounded control-store rows.

## 12. Public and internal API

Publish an OpenAPI 3.1 contract. Prefix self-platform endpoints with `/platform/backup/v1`.

### 12.1 Cluster and policy

```text
POST   /clusters
GET    /clusters/{cluster_id}
GET    /clusters/{cluster_id}/topology
POST   /clusters/{cluster_id}/discover
GET    /clusters/{cluster_id}/backup-policy
PUT    /clusters/{cluster_id}/backup-policy
POST   /clusters/{cluster_id}/pitr/enable
POST   /clusters/{cluster_id}/pitr/disable
POST   /clusters/{cluster_id}/checks
```

`pitr/disable` disables future WAL archiving only after warning that it breaks the future recovery window. It does not silently delete repository data.

### 12.2 Backup jobs

```text
POST   /clusters/{cluster_id}/backups
GET    /clusters/{cluster_id}/backups
GET    /clusters/{cluster_id}/backup-status
GET    /jobs/{job_id}
GET    /jobs/{job_id}/events
POST   /jobs/{job_id}/cancel
POST   /jobs/{job_id}/retry
```

All mutating requests accept `Idempotency-Key`. Long-running operations return `202 Accepted` with a `job_id`.

Job events are exposed as SSE with monotonically increasing event IDs. Clients reconnect with `Last-Event-ID`; the API supports bounded historical replay and returns a snapshot when the requested cursor has expired.

### 12.3 Restore

```text
POST   /clusters/{cluster_id}/restore-plans
GET    /restore-plans/{plan_id}
POST   /restore-plans/{plan_id}/confirm
POST   /restore-plans/{plan_id}/execute
```

Plan creation is read-only. It returns:

- normalized UTC recovery target;
- selected base backup and repository;
- recoverability evidence: candidate backup, observed archive range, timeline history, latest archived WAL, and confidence (`inferred`, `drill_verified`, or `unknown`);
- current topology and affected nodes;
- whether automatic standby rebuild is supported;
- required free space;
- expected service impact;
- blocking conditions;
- a hash of every safety-relevant input.

Confirmation binds the user to the exact plan hash and expires after 15 minutes. Any topology, policy, repository, fencing capability, provider capability, or target change invalidates it. `pgbackrest info` archive min/max is never presented as proof of gap-free WAL coverage; only a successful isolated recovery drill may report `drill_verified`.

### 12.4 Error model

```json
{
  "code": "TOPOLOGY_UNSTABLE",
  "message": "The cluster primary changed during restore planning.",
  "retryable": true,
  "details": {},
  "correlation_id": "..."
}
```

Stable codes are required for Studio behavior. Do not parse command output strings in the UI.

## 13. PITR enablement workflow

```text
1. Acquire cluster and repository leases.
2. Discover topology and verify one writable primary.
3. Verify all nodes share the expected PostgreSQL system identifier.
4. Validate repository access from the chosen backup node and primary.
5. Render candidate pgBackRest configuration.
6. Validate configuration without installing it.
7. Atomically install configuration on required nodes.
8. Configure archive_mode and archive_command on the primary.
9. Coordinate the required PostgreSQL restart through the HA/runtime driver.
10. Run stanza-create.
11. Run pgBackRest check and force a WAL switch.
12. Run the first full backup.
13. Publish observed state and mark the policy generation applied.
14. Release leases.
```

If a restart causes a primary change, rediscover topology and validate that the new primary has the same desired configuration before continuing.

## 14. Scheduled backup workflow

The Operator scheduler scans due policies every 30 seconds and claims schedules transactionally. It creates a job instead of directly executing work.

For standby backup:

1. discover topology;
2. verify the designated standby is healthy and below the configured lag threshold;
3. verify the primary remains reachable;
4. construct a cluster execution target containing primary, standby, coordinator/repository host, and repository;
5. verify symmetric pgBackRest configuration and repository/stanza identity on all participating hosts;
6. run pgBackRest standby backup, allowing pgBackRest to coordinate the primary backup start/stop and standby replay position;
7. inspect repository facts and reconcile the job annotation/manifest;
8. publish status;
9. alert if the resulting recovery window regressed.

If the standby is unavailable, policy decides whether to fail or fall back to the primary. The default is fail, because an automatic fallback may unexpectedly add load to the primary.

## 15. Cluster PITR restore workflow

PITR is a cluster-wide destructive operation. Old standbys cannot rejoin a restored primary.

### 15.1 Planning phase

Planning performs no destructive action:

1. acquire a short-lived planning lease;
2. discover primary, standbys, HA manager, timeline, system identifier, and replication lag;
3. inspect pgBackRest backups and archived WAL;
4. normalize and validate the requested target;
5. select a candidate backup whose `timestamp.stop` is at or before the target, or allow pgBackRest to choose the eligible backup;
6. report inferred archive/timeline evidence without claiming gap-free WAL coverage;
7. check free space and quarantine capacity on the restore node;
8. verify every required Agent is reachable;
9. require a concrete write-fence provider and verify its capabilities;
10. verify the selected recovery strategy and topology provider capabilities;
11. create an immutable restore plan and plan hash;
12. release the planning lease.

### 15.2 In-place execution phase

```text
1. Validate confirmation token and plan hash.
2. Acquire exclusive cluster and repository leases.
3. Rediscover topology and compare it with the plan.
4. Enter platform maintenance mode.
5. Engage and verify the complete write fence: reject new connections/writes, drain or terminate active writers, resolve prepared transactions, and prove no alternate writable primary.
6. Pause automatic failover and capture DCS/controller evidence. Patroni pause alone is not a fence.
7. Apply the topology-provider-specific shutdown sequence. For synchronous replication, do not stop required standbys until write transactions are drained and the provider has handled synchronous settings safely.
8. Verify every PostgreSQL node is stopped. Unreachable required nodes block continuation.
9. Quarantine the primary PGDATA using an atomic rename when the runtime supports it.
10. Prepare an empty target directory with verified ownership and capacity.
11. Disable repository writes for the isolated recovery instance (`archive_mode`/archive command or pgBackRest stop policy).
12. Run pgBackRest restore with typed target-time, timeline, and target-action options.
13. Start the restored node on an isolated endpoint with application traffic still fenced.
14. Wait for recovery to reach the requested target. Failure to reach it is a restore failure, not a partial success.
15. Validate system identifier, new timeline, target transaction markers, SQL health, extensions, and Supabase service roles.
16. Declare the restored node through the topology provider and reconcile Patroni/DCS state when applicable.
17. Quarantine old standby data directories.
18. Rebuild every standby through the topology provider. Prefer Patroni/native reinitialize or a fresh restore/base backup; pgBackRest delta is disabled until a dedicated timeline-safety spike proves it.
19. Wait for streaming state and configured lag threshold on every required standby.
20. Enable archiving on the accepted new primary, verify timeline history, run pgBackRest check, and verify a forced WAL switch reaches the repository.
21. Resume HA automation and verify a single leader/primary.
22. Release the write fence and exit maintenance mode.
23. Run application-level health checks.
24. Publish backup/topology status and release locks.
```

### 15.3 Replacement-workload execution phase

Self-managed Kubernetes deployments use this state machine:

```text
1. Validate confirmation and acquire control-store locks.
2. Create a new PVC and replacement StatefulSet definition using the allowlisted customized PostgreSQL image.
3. Restore the requested target with the image-managed pgBackRest binary through a restricted Job.
4. Start the replacement primary and rebuild requested replicas from the accepted history.
5. Validate the new cluster through an isolated Service/endpoint.
6. Engage and verify the write fence on the old cluster and application data plane.
7. Atomically switch project registry/Service routing to the new cluster.
8. Verify all Supabase services and direct connection metadata use the new endpoint.
9. Enable/check archiving with a non-conflicting pgBackRest stanza/database-history identity.
10. Release the write fence.
11. Retain the old StatefulSet/PVCs as quarantine until the rollback window expires.
```

The default strategy never edits the source PVC in place. If an optional managed-operator provider owns the workload, the generic strategy fails closed and never mounts or edits controller-owned PVCs behind that controller.

### 15.4 Point of no automatic rollback

For in-place restore, the point of no automatic rollback is the PGDATA quarantine/restore start. For replacement-workload restore, traffic cutover is reversible only while the old workload remains fenced, unchanged, and able to resume safely.

The original PGDATA must be retained under a job-specific quarantine path until:

- the restored primary is healthy;
- all required standbys are rebuilt;
- application checks pass;
- the configured quarantine retention expires;
- an administrator explicitly approves deletion when policy requires it.

Never delete the old data directory, PVC, or Cluster at restore start.

Returning to quarantined PGDATA is a separate `RollbackPlan`, not a directory rename. It must fence the new timeline, prevent repository pollution, reconcile Patroni/DCS or Kubernetes routing, restore the old primary identity, and rebuild standbys again.

### 15.5 Standby rebuild strategies

Driver preference order:

1. HA controller native reinitialize, such as Patroni reinitialize, when that controller is positively identified.
2. fresh pgBackRest standby restore or base backup into an empty data directory.
3. pgBackRest delta restore only after a dedicated destructive spike proves it safe for the provider and new timeline; it is disabled by default.

Old standby data is never allowed to reconnect without reinitialization after PITR.

## 16. Failure and recovery semantics

| Failure | Required behavior |
| --- | --- |
| Agent unreachable before downtime | Block the job; no side effects |
| Agent lost after DB stop | Hold cluster lock, inspect on reconnect, do not blindly replay |
| Agent/control lease lost while restore runs | Mark `orphaned_execution`; keep local execution lock; prohibit automatic takeover |
| Primary changes during planning | Invalidate plan and require new confirmation |
| Primary changes during enablement | Rediscover and reconcile desired generation |
| HA pause fails | Abort before write fencing or data changes |
| Repository check fails | Abort; keep current database running |
| Restore command fails | Keep restored target stopped, retain original PGDATA, enter compensation/manual state |
| Restored primary fails SQL validation | Keep writes fenced; allow operator-directed rollback to quarantined PGDATA |
| One standby rebuild fails | Keep primary healthy; default to maintenance until policy/user decides degraded release |
| Operator restarts | Reconcile active jobs from durable step and Agent postconditions |
| Duplicate API request | Return the existing job by idempotency key |
| Lost cluster lease | Stop dispatching new steps and enter manual review for destructive jobs |
| Control store unavailable | Agent continues only the current explicitly safe operation; destructive work enters orphaned/manual state before another transition |
| Control store resolves to managed cluster | Reject registration/restore capability |
| Write fence cannot prove zero writers | Abort before stopping any PostgreSQL node |
| Isolated restore attempts archive-push | Block repository writes and fail validation |

The default release policy requires every registered required standby to be healthy. A future policy may allow service restoration in degraded mode, but it must be an explicit pre-approved setting.

## 17. Concurrency and locking

Lock scopes:

- `cluster/{id}/destructive`: restore, failover coordination, topology mutation;
- `cluster/{id}/backup-config`: enable/disable and policy application;
- `repository/{id}/stanza/{stanza}/{operation-class}`: stanza creation, expiration, archive mutation, and conflicting backup operations;
- `node/{id}/runtime`: stop/start/data-directory mutation.

Leases include owner, fencing token, acquired time, heartbeat, expiration, and job ID. Every Agent task that mutates state carries the current fencing token. Agents reject stale tokens before execution. A token cannot revoke an already running external command; non-takeover and orphan reconciliation provide that safety.

Backups may run concurrently across independent stanzas when repository/provider policy permits it. Restore is primarily a repository reader; it blocks only operations that can mutate or expire the same stanza/archive history. The implementation must also respect pgBackRest's native lock behavior rather than layering an unnecessary repository-wide mutex.

## 18. Security model

### 18.1 User authorization

- read status: project `READ` permission;
- change policy or run backup: new backup-management permission mapped to Owner/Admin by default;
- create restore plan: infrastructure execute permission;
- confirm and execute restore: Owner plus recent MFA/AAL2, unless an organization defines a stricter role;
- release a manual-intervention lock: Owner plus explicit audit reason.

Existing cloud billing permissions such as `stripe.subscriptions` must not control self-hosted backup operations.

Restore confirmation and execution require the independent control store to be healthy. If platform identity/RBAC is hosted inside the target cluster, authorization is completed and durably copied into the signed restore plan before downtime; the independent Operator remains able to finish the already authorized job while Studio is offline.

### 18.2 Service authentication

- Studio/self-platform to Operator: short-lived signed service JWT with user, org, project, permissions, audience, and request ID.
- Operator to Agent: mTLS with per-Agent certificates and enrollment identity.
- Certificates rotate without Agent re-enrollment when possible.
- Agent outbound streams verify Operator identity and pin the expected trust domain.

### 18.3 Privilege separation

Agent runs as `supabase-backup-agent`, not root. Privileged operations use one of:

- fixed root-owned helper binaries with typed stdin;
- narrowly scoped sudoers entries for fixed helpers;
- Kubernetes ServiceAccount with resource-level RBAC;
- a restricted Docker API proxy.

Do not grant arbitrary `sudo`, arbitrary `systemctl`, arbitrary filesystem paths, or arbitrary Docker API access.

### 18.4 Secrets

- Repository credentials are envelope-encrypted in the independent control store, never in a managed cluster.
- Agent receives short-lived credentials when the storage backend supports them.
- Secret values never appear in task logs, audit payloads, command arguments, or Studio responses.
- Configuration renderers write secrets with restrictive permissions and use atomic rename.

### 18.5 Audit

Every state-changing request records:

- actor and organization;
- source IP/session/request ID;
- cluster and nodes;
- normalized input with secrets removed;
- plan hash and confirmation identity;
- previous and new desired generation;
- dispatched operation names;
- timestamps and outcomes;
- manual overrides and reasons.

## 19. Observability

Expose Prometheus metrics:

- `backup_operator_jobs_total{type,state}`
- `backup_operator_job_duration_seconds{type}`
- `backup_operator_step_retries_total{operation}`
- `backup_operator_agent_connected{cluster,node}`
- `backup_operator_agent_last_seen_seconds{cluster,node}`
- `backup_operator_backup_age_seconds{cluster}`
- `backup_operator_wal_archive_lag_seconds{cluster}`
- `backup_operator_restore_duration_seconds{phase}`
- `backup_operator_replica_rebuild_duration_seconds{node}`
- `backup_operator_lease_conflicts_total{scope}`
- `backup_operator_orphaned_executions{cluster,node}`
- `backup_operator_event_backlog{consumer}`
- `backup_operator_control_store_available`

Structured logs include `correlation_id`, `job_id`, `step_id`, `cluster_id`, and `node_id`. Command output is captured with size limits and secret redaction.

Cardinality is bounded: cluster/node labels use stable internal IDs, never job IDs, repository paths, error messages, or user input. Job-specific detail stays in structured logs/events.

Recommended alerts:

- no successful backup within policy SLA;
- WAL archive freshness exceeded;
- pgBackRest check failed;
- Agent offline;
- schedule missed;
- active job heartbeat stale;
- job in `manual_intervention`;
- standby rebuild incomplete;
- repository capacity below threshold.
- control store unavailable or located in a managed recovery domain;
- orphaned destructive execution;
- event/log backpressure or dropped progress chunks.

## 20. Compatibility with the current Studio implementation

### 20.1 Preserve the existing read contract

During migration, the Operator publishes its pgBackRest observation into the existing project-database singleton:

```sql
_supabase_platform.pgbackrest_info(id, info, updated_at)
```

This keeps `GET /platform/database/{ref}/backups` and current Studio pages working. It is a non-authoritative projection: restore jobs, locks, audit events, confirmations, and secrets remain in the independent control store.

Later, Studio may read richer status directly from the Operator. The compatibility publisher remains optional for older Studio versions.

### 20.2 Replace cloud Add-ons semantics in self-platform mode

Under `IS_SELF_PLATFORM`, the PITR settings UI should stop using:

- cloud billing variants `pitr_7`, `pitr_14`, and `pitr_28` as product SKUs;
- Stripe subscription permissions;
- compute-size upgrade prompts;
- the current GET-only empty Add-ons stub.

It should use the backup policy/status endpoints and present actual retention, repository health, topology, and job state.

### 20.3 Restore UI

When Operator capability reports either `restore.in_place=true` or `restore.replacement_cluster=true`, Studio may enable the corresponding restore flow. Capability response must also state:

- supported deployment driver;
- HA integration;
- automatic standby rebuild availability;
- reachable/required nodes;
- current blocking reasons.

The UI must not infer support only from `pitr_enabled`.

## 21. Configuration

Example Operator configuration:

```yaml
mode: operator
listen: 0.0.0.0:8180
grpc_listen: 0.0.0.0:8181
control_database_url_file: /run/secrets/backup_control_database_url
control_store: postgres
encryption_key_file: /run/secrets/operator_encryption_key
public_base_url: https://platform.internal/backup
scheduler_interval: 30s
lease_ttl: 30s
agent_stale_after: 30s
restore_confirmation_ttl: 15m
event_retention: 30d
audit_retention: 365d
log_format: json
```

Example bare-metal Agent enrollment:

```yaml
mode: agent
operator_address: backup-operator.internal:8181
cluster_id: 7d9d...
node_id: 0a31...
transport: outbound-grpc
runtime_driver: systemd
topology_provider: patroni
postgres:
  unit: patroni.service
  data_dir: /var/lib/postgresql/17/main
  socket_dir: /var/run/postgresql
pgbackrest:
  binary: /usr/bin/pgbackrest
  config: /etc/pgbackrest/pgbackrest.conf
  stanza: supabase
allowed_paths:
  - /var/lib/postgresql/17/main
  - /etc/pgbackrest
```

Configuration paths and service names are enrollment-time values controlled by an administrator, not request-time API parameters.

## 22. Delivery plan

The final scope includes every deployment mode, but implementation should land in independently verifiable milestones.

### Milestone 0: destructive feasibility spikes and architecture pins

Run three throwaway-but-documented destructive spikes before freezing interfaces:

1. prove that all-in-one `_platform` cannot be the control store during restore, then validate independent PostgreSQL and external SQLite control-store modes through target-cluster downtime/PITR;
2. execute a real Patroni PITR on one primary and two standbys, recording DCS, pause, fencing, synchronous replication, archiving, and reinitialize behavior;
3. execute customized Supabase PG17 Kubernetes recovery by creating a replacement StatefulSet/new PVC, validating it through an isolated Service, switching the stable Service, and rolling back without mutating the old PVC; record an explicit OrioleDB17 capability result.

Also spike write fencing for Supabase services plus direct PostgreSQL connections. Produce binding fixtures, command transcripts with secrets removed, failure observations, and final capability boundaries.

Exit criteria: the review's four blocking risks have observed solutions, and the resulting interfaces distinguish in-place, replacement-workload, and optional managed-replacement recovery.

### Milestone 1: contracts, control store, and read-only discovery

- create the Go module and binary modes;
- define OpenAPI and Agent protobuf contracts from Milestone 0 evidence;
- implement independent PostgreSQL and SQLite `ControlStore` backends;
- add domain models, migrations, transactional outbox/results, and store tests;
- implement job/step reconciliation, leases, orphaned execution, and local Agent locks;
- implement authentication with production interfaces;
- implement Agent enrollment and outbound mTLS stream;
- implement PostgreSQL identity/topology and pgBackRest inspection;
- reject control stores in a managed recovery domain;
- publish the existing `pgbackrest_info` compatibility contract;
- add CI for format, lint, generated-contract drift, unit tests, race tests, and vulnerability scanning.

Exit criteria: a synthetic job survives Operator/Agent restart and duplicate dispatch without duplicate destructive effects; target-cluster downtime does not interrupt the control store.

### Milestone 2: policy, enablement, and backup jobs

- repository registration and encrypted secrets;
- enforce unique repository/stanza/system-identifier binding;
- pgBackRest config validation/application;
- PITR enablement state machine;
- schedules and manual backup jobs;
- cluster-aware primary and designated-standby backup;
- repository-fact reconciliation through job annotations/manifests;
- Studio self-platform PITR panel replacement.

Exit criteria: enable PITR and complete scheduled backups on bare metal and Compose, with restart-safe jobs and audit history.

### Milestone 3: single-primary in-place restore

- restore planning and confirmation;
- concrete Supabase/direct-connection `WriteFenceProvider`;
- quarantine and restore workflow;
- isolated validation with repository writes disabled;
- orphaned execution and non-takeover behavior;
- validation and rollback-to-quarantine runbook;
- Studio restore UI for clusters without standbys.

Exit criteria: destructive E2E tests restore a known fixture to a target second on bare metal and Compose.

### Milestone 4: Patroni multi-standby orchestration

- cluster-wide stop/fence workflow;
- automatic standby quarantine and rebuild;
- required/degraded standby policy;
- Patroni/DCS topology provider with synchronous replication handling;
- repository timeline transition and archive re-enable checks;
- per-node progress in Studio.

Exit criteria: a one-primary/two-standby cluster restores to target time and both standbys rejoin the new timeline automatically.

### Milestone 5: Kubernetes replacement-workload recovery

- generic Kubernetes runtime and restricted task Job adapter for explicitly self-managed StatefulSets using customized PG17/OrioleDB17 images;
- Kubernetes secrets and ServiceAccount manifests;
- customized-image pgBackRest provider integration;
- replacement StatefulSet/new PVC recovery, isolated validation, Service/registry cutover, quarantine, and rollback;
- Kubernetes Lease integration;
- Helm/Kustomize deployment assets.

Exit criteria: the same user-facing API restores single-instance and multi-instance Kubernetes deployments through the appropriate strategy without core CloudNativePG/cert-manager/Barman dependencies; every image variant passes capability detection before destructive execution.

### Milestone 6: production hardening

- certificate rotation;
- chaos and restart testing;
- large repository and long-running restore testing;
- upgrade compatibility matrix;
- operator/agent rolling upgrade protocol;
- backup SLA alerts and capacity forecasting;
- security review and least-privilege deployment validation.
- event/audit partitioning and retention;
- log/progress backpressure and object-storage offload;
- release artifacts, SBOM, signing, provenance, and upgrade/rollback automation.

## 23. Testing strategy

### 23.1 Unit tests

- state transition legality;
- idempotency and fencing-token checks;
- restore-target normalization;
- plan hash stability;
- command argument construction without shell interpolation;
- driver error classification;
- permission matrix;
- secret redaction;
- schedule calculation around time zones and DST.
- candidate backup selection requires `backup.stop <= target`;
- recoverability confidence never upgrades inferred WAL range to verified;
- provider capability gating for in-place, replacement-workload, and optional managed-replacement restore;
- cancellation policy for every step (`safe`, `deferred`, or `forbidden-after-start`).

### 23.2 Store and reconciliation tests

Use real PostgreSQL in integration tests:

- competing workers claim one step;
- lease expiry and renewal;
- Operator crash between persistence and dispatch;
- duplicate Agent result;
- stale Agent token rejection;
- migration upgrade and rollback compatibility.
- transactional outbox crash before/after dispatch;
- independent control store remains available while the target cluster is stopped and restored;
- registration rejects a control store inside the managed cluster;
- Agent SQLite loss/re-enrollment reconciles backup facts without blindly rerunning a destructive command;
- event retention, SSE cursor replay, and expired cursor snapshot behavior.

### 23.3 Driver contract tests

Every runtime and HA driver must pass a shared contract suite:

- discover stable topology;
- detect role mismatch;
- stop/start idempotently;
- reject an unapproved target;
- survive already-stopped/already-running state;
- report typed failure and postconditions.

### 23.4 Destructive E2E matrix

| Environment | Topology | Backup node | Restore | Standby rebuild |
| --- | --- | --- | --- | --- |
| Bare metal VM | single primary | primary | required | n/a |
| Bare metal VM | primary + 2 standbys | designated standby | required | required |
| Docker Compose | single primary | primary | required | n/a |
| Docker Compose | primary + standby | standby | required | required |
| Kubernetes | single instance | primary | required | n/a |
| Kubernetes | 3 instances | designated replica | required | required |
| All-in-one self-platform | target contains `_platform` | primary | required with external control store | n/a |
| Patroni | primary + 2 synchronous standbys | standby | required | required |
| Customized Kubernetes PG17 | 3 instances | designated replica | replacement StatefulSet/new PVC required | required |
| Optional managed operator | provider-specific | provider native | managed replacement required | controller generated |
| Shared repository | 2 clusters, distinct stanzas | concurrent | isolation required | n/a |

Each deterministic core test creates a named restore point or an explicit committed transaction marker, writes marker rows after it, restores, and verifies:

- pre-target rows exist;
- post-target rows do not exist;
- timeline changed as expected;
- no old standby data rejoined;
- rebuilt standbys stream from the restored primary;
- Supabase Auth, REST, Storage metadata, and required roles remain healthy.

Separate time-target tests cover UTC normalization, transaction commit boundaries, clock skew, and inclusive/exclusive behavior. They must not use wall-clock timing as the only oracle.

### 23.5 Failure injection

Inject failures after every destructive step:

- kill Operator;
- kill Agent;
- remove network connectivity;
- expire a lease;
- fail repository access;
- fill target disk;
- make one standby unreachable;
- trigger attempted HA failover;
- return duplicate/out-of-order task results.
- make the independent control store unavailable before and during a destructive command;
- allow a lease to expire while `pgbackrest restore` continues;
- attempt manual Patroni promotion while the cluster is paused;
- interrupt Patroni DCS and leave a stale leader key;
- use synchronous replication and stop a required standby;
- create a WAL archive gap inside reported min/max bounds;
- reuse a repository/stanza with a different system identifier;
- attempt archive-push from an isolated restored instance;
- race an optional managed-operator reconciliation with recovery/cutover;
- rotate or expire object-store credentials during backup/restore;
- inject object-store throttling, eventual visibility delay, and partial network failure;
- run scale fixtures with multi-terabyte metadata estimates and millions of WAL objects.

The resulting state and recovery procedure must match the documented state machine.

### 23.6 Performance and capacity tests

- Scheduler queries use a partial index on `(next_run_at)` for enabled policies and claim bounded batches.
- Topology refresh batches node observations and does not issue an unbounded N+1 query per Studio request.
- `job_events` and `audit_events` partitions are tested for pruning, export, and retention deletion.
- Agent progress/log streams enforce backpressure, bounded local disk queues, and explicit dropped-progress counters without dropping final results.
- SSE consumers reconnect from a cursor without replaying an unbounded event history.
- Repository operations limit object-store concurrency and honor provider throttling/retry hints.
- Restore planning includes PGDATA, quarantine, WAL spool, temporary files, and safety margin in capacity checks; capacity is rechecked immediately before quarantine.
- Quarantine cleanup is a separate audited job and never runs while a rollback window or manual-intervention lock is active.

Required PostgreSQL index shape:

```sql
create index backup_policies_due_idx
  on backup_operator.backup_policies(next_run_at)
  where enabled = true;
```

## 24. Upgrade and compatibility

- Operator and Agent advertise protocol versions and capabilities.
- Operator only dispatches operations supported by the connected Agent.
- Additive protobuf/OpenAPI changes are backward compatible within one minor version.
- Database migrations are forward-only in production; application rollback must tolerate the new schema.
- During rolling upgrades, old Agents continue observation and existing operations but cannot receive unsupported new tasks.
- A destructive job pins its protocol and driver implementation versions at plan time. Upgrade deployment is blocked while such a job is active.

### 24.1 Build and distribution

The feature is not shipped until artifacts are reproducible and installable:

- publish `backup-operator`, Agent mode, and `backupctl` for Linux amd64/arm64;
- publish a minimal multi-architecture OCI image for Operator/Kubernetes task roles;
- provide checksums, SBOM, signed images/binaries, and build provenance;
- provide versioned systemd units/install packages, Compose manifests, and Helm/Kustomize assets;
- publish the Operator/Agent/API compatibility matrix;
- support pinned-version upgrades and documented rollback;
- CI verifies generated OpenAPI/protobuf artifacts, container startup, migrations, and installation assets.

## 25. Operational runbooks required before production

1. Install and enroll a bare-metal Agent.
2. Deploy Operator and Agent in Compose.
3. Deploy Kubernetes controller/Jobs with least-privilege RBAC.
4. Configure S3-compatible and POSIX repositories.
5. Enable PITR and verify WAL archiving.
6. Rotate repository credentials and Agent certificates.
7. Recover an offline/stale Agent.
8. Resolve every `manual_intervention` checkpoint.
9. Roll back to quarantined PGDATA after failed validation.
10. Rebuild a failed standby manually.
11. Upgrade Operator, Agents, and schema.
12. Export audit evidence and diagnose missed backup SLA.

## 26. Key architecture decisions

| Decision | Choice | Reason |
| --- | --- | --- |
| Implementation language | Go | Static binary, low idle footprint, strong concurrency and Kubernetes ecosystem |
| Deployables | One binary, Operator and Agent roles | Lightweight packaging without mixing trust boundaries |
| Control store | Independent PostgreSQL in production; external SQLite in single-host mode | Restore authority cannot be stopped or rolled back with the managed cluster |
| Queue | Control-store-backed jobs and transactional outbox | Avoid mandatory broker while preserving durable dispatch/reconciliation |
| Node connectivity | Outbound mTLS stream by default | No inbound management port on database hosts |
| Execution | Typed Agent operations | Prevent general remote-code execution |
| Recovery model | In-place, replacement-workload, and optional managed-replacement strategies | Filesystem restore, self-managed Kubernetes replacement, and controller-managed recovery have different authority boundaries |
| Runtime support | Capability-oriented providers | Keep orchestration independent without forcing incompatible lifecycle semantics into one interface |
| HA support | Separate topology provider | Prevent runtime control from bypassing Patroni or an optional recognized operator authority |
| Restore unit | Whole PostgreSQL cluster | Physical PITR changes the timeline and invalidates old standbys |
| Old data handling | Quarantine, delayed deletion | Preserve a manual rollback path after destructive work begins |
| Status migration | Continue publishing `pgbackrest_info` | Preserve current Studio compatibility |
| Multi-node policy | Central decisions, node-local execution | Avoid conflicting independent Agents |
| Delivery guarantee | At-least-once dispatch with reconciled effects | External commands cannot provide generic exactly-once semantics |
| Destructive takeover | Prohibited while outcome is uncertain | Lease expiry cannot safely cancel or transfer a running restore |
| Kubernetes default recovery | Customized image, replacement StatefulSet/new PVC, and Service cutover | Reuse packaged pgBackRest and avoid a second mandatory database platform |

## 27. Open implementation decisions

These decisions must be resolved during Milestone 0, but they do not change the architecture:

1. Select the exact independent control PostgreSQL deployment/package for the self-platform Compose distribution.
2. Define and prove the complete write-fencing mechanism for each supported Supabase deployment; lack of proof disables restore capability.
3. Pin the verified OrioleDB17 image digest and retain its Supabase role/extension initialization preflight. The 2026-07-12 image now includes managed pgBackRest 2.58.0 and passed the replacement-PVC destructive matrix.
4. Decide whether a failed optional standby may permit degraded service restoration. Default remains no.
5. Define repository credential issuance for each S3 provider. Static credentials are supported; short-lived credentials are preferred.
6. Define quarantine retention defaults and capacity thresholds separately for in-place directories, Docker volumes, and Kubernetes resources.

## 28. Definition of done

The overall project is done when:

- the APIs, protobuf protocol, database schema, and all named drivers are implemented and versioned;
- authoritative control state is independent of every managed recovery domain and remains available throughout restore;
- Studio self-platform no longer presents cloud billing semantics for PITR;
- PITR enablement and backup jobs work on bare metal, Compose, and Kubernetes;
- single-primary and multi-standby restores pass the destructive E2E matrix;
- Kubernetes recovery uses a replacement StatefulSet/new PVC set and verified cutover, never hidden in-place PVC mutation;
- every advertised restore capability has a tested write-fence provider;
- all old standbys are automatically rebuilt or the cluster remains safely fenced with an actionable manual state;
- restart, retry, lease loss, orphaned execution, and duplicate delivery behavior pass failure-injection tests without automatic destructive takeover;
- permissions, mTLS, secret storage, least-privilege Agent deployment, and audit trails pass security review;
- existing read-only backup pages continue working through the compatibility publisher;
- production runbooks cover installation, recovery, upgrade, and manual intervention.

## 29. Recommended first coding slice

Start with Milestone 0 rather than freezing a greenfield driver hierarchy:

1. provision an independent control PostgreSQL and an external SQLite fixture;
2. prove both stores survive target-cluster stop and PITR;
3. execute and document a Patroni primary/two-standby PITR, including synchronous replication and DCS failure cases;
4. execute and document a customized Supabase PG17 replacement-StatefulSet recovery and Service rollback, with explicit OrioleDB17 capability detection;
5. prove a concrete Supabase/direct-connection write fence;
6. use those observations to finalize `ControlStore`, `RecoveryStrategy`, `TopologyProvider`, `WriteFenceProvider`, and `BackupProvider` contracts;
7. then create `apps/backup-operator`, implement the stores, read-only Agent, transactional outbox, local execution lock, and compatibility publisher;
8. prove restart, duplicate delivery, lease loss, and orphaned execution before adding enablement or restore mutations.

This slice establishes the dangerous boundaries from evidence before abstractions harden. It still introduces no production destructive API until all blocking invariants are tested.

## GSTACK REVIEW REPORT

### Runs / Status / Findings

| Run | Status | Findings absorbed |
| --- | --- | --- |
| Architecture review | revised | Independent control store, explicit write fencing, Patroni authority, lightweight customized-image Kubernetes replacement, optional managed-operator boundary |
| Code-quality review | revised | Capability-oriented providers, transactional outbox, local execution lock, no exactly-once claim, reduced premature abstraction |
| Test review | revised | Control-store recovery-domain tests, Patroni and customized-image Kubernetes destructive spikes, WAL-gap/stanza/synchronous-replication/orphan cases |
| Performance review | revised | Indexed scheduler, event/audit retention, SSE cursors, log backpressure, object-store limits, quarantine cleanup |
| Outside review | revised | Correct backup selection, standby coordination, repository pollution prevention, non-takeover semantics, delivery artifacts |

VERDICT: REVISED PLAN IS READY FOR MILESTONE 0 SPIKES; DESTRUCTIVE PRODUCTION IMPLEMENTATION REMAINS BLOCKED UNTIL THE SPIKE EXIT CRITERIA PASS.

**UNRESOLVED DECISIONS:**

- Select the packaged independent control PostgreSQL deployment for self-platform Compose.
- Prove and select the concrete direct-connection write-fence mechanism for each deployment.
- Keep managed-operator support optional; select an integration only after a real deployment requires it and the customized image is proven compatible.
- Set quarantine retention/capacity defaults and the optional-standby degraded-release policy.
