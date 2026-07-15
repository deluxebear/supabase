# Dual-profile Studio platform architecture and development standard

- Date: 2026-07-15
- Last engineering review: 2026-07-15
- Status: reviewed architecture baseline for implementation
- Repository branch: `custom/main`
- Applies to: `apps/studio`, `apps/backup-operator`, the planned Fleet control-plane packages, `docker/`, and `docker/self-platform/`
- Replaces: no existing design document; this document consolidates and governs the existing milestone designs

## 1. Purpose

This document defines the target architecture, product boundaries, development rules, and delivery gates for maintaining two self-hosted Studio products from one upstream-synchronized codebase:

1. **Embedded Studio**: Studio is deployed with one Supabase stack. It preserves the official self-hosted behavior and adds localization only.
2. **Fleet Studio**: Studio is deployed as an independent control plane that registers and manages multiple Supabase stacks across Docker Compose, Kubernetes, and bare-metal environments.

This is the normative baseline for future plans and implementation tasks. A task that conflicts with this document must either update this document first or include an Architecture Decision Record (ADR) that explicitly supersedes the affected decision.

The words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** express requirement strength.

Implementation status labels are used where a target design could otherwise be mistaken for shipped behavior:

- **CURRENT**: verified in the repository today;
- **TRANSITION**: compatibility behavior required while migrating existing deployments;
- **TARGET**: normative behavior that must be implemented before the affected capability is advertised.

Terminology is fixed throughout this document:

| Term              | Meaning                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------- |
| Fleet project     | Studio routing and authorization identity represented by `projectRef`                                       |
| Supabase stack    | One logical Supabase installation, including its PostgreSQL and service data plane                          |
| Management target | A registered Fleet control endpoint and trust domain                                                        |
| Stack binding     | The one-to-one attachment between a Fleet project and a Supabase stack identity                             |
| Execution target  | The concrete host, Compose project, Kubernetes namespace/workload, or systemd installation used by an Agent |
| Recovery domain   | Infrastructure that can fail or be restored together; control state must not share this domain              |

### 1.1 Engineering review findings absorbed on 2026-07-15

| Severity / confidence | Problem verified in the baseline                                                                   | Correction in this revision                                                         |
| --------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| P1 / 10               | Next.js inlines current `NEXT_PUBLIC_*` profile flags during build                                 | Canonical build-time profile, legacy validation, and separate image build jobs      |
| P1 / 10               | Existing Go APIs and stores are explicitly backup/recovery-specific                                | Separate Fleet Control and Backup Operator bounded contexts                         |
| P1 / 10               | Current all-in-one Fleet Compose stores `_platform` inside the default managed PostgreSQL cluster  | Production control stores moved outside every managed recovery domain               |
| P1 / 10               | Fleet project APIs return an encrypted DSN derived from the database password                      | Server-side Fleet pg-meta proxy; no connection material in browser responses        |
| P1 / 9                | Desired state and operation ownership were assigned to both platform and Operator                  | Single-authority matrix, transactional outbox, immutable execution snapshot         |
| P1 / 9                | `select 1` currently creates an `ACTIVE_HEALTHY` project without proving stack identity            | Staged multi-service preflight, stable fingerprint, and duplicate protection        |
| P2 / 9                | One status enum mixed attachment, data-plane health, Agent connectivity, drift, and jobs           | Independent status dimensions with a derived UI summary                             |
| P1 / 9                | Multi-target enrollment lacked token binding, CSR, rotation, revocation, and replay rules          | Explicit single-use enrollment and mTLS certificate lifecycle                       |
| P2 / 9                | Runtime mutation did not define ownership when Compose/GitOps/Kubernetes also manage configuration | Observe-only, direct-managed, GitOps modes, and field/file ownership conflicts      |
| P2 / 8                | Edge Function deployment lacked atomic activation, artifact security, and rollback semantics       | Immutable artifact revisions, atomic pointers, probes, rollback/manual intervention |
| P2 / 10               | Prior runtime failures exposed null arrays, empty JSON, and silently incompatible required fields  | Non-null collections, defensive response parsing, and versioned response contracts  |
| P2 / 8                | No tested scale envelope, reconnect-storm behavior, or per-target backpressure was specified       | Initial capacity envelope, jitter, quotas, bounded concurrency, and load tests      |
| P1 / 10               | Platform SQL upgrades can require manual file application on existing data                         | Versioned checksum migration runner with locking and readiness enforcement          |

## 2. Executive decisions

| ID  | Decision                                                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | Maintain one long-lived customization branch, `custom/main`, and build both products from the same commit in separate profile-specific jobs.         |
| A2  | Replace ambiguous boolean-only product checks with a build-time typed deployment profile and a runtime project-capability model.                     |
| A3  | Embedded Studio preserves upstream self-hosted semantics. Fleet-only behavior must not leak into it.                                                 |
| A4  | Fleet Studio uses direct project-scoped access for data-plane operations and control-service/Agent reconciliation for privileged runtime operations. |
| A5  | Studio never receives Docker socket, SSH root, or cluster-admin Kubernetes access.                                                                   |
| A6  | Operators send typed, versioned operations. Agent never accepts arbitrary shell commands.                                                            |
| A7  | Every Fleet feature is capability-gated. Unsupported operations are hidden or disabled with a reason; no endpoint may return false success.          |
| A8  | Desired state and observed state are distinct. A saved configuration is not “applied” until an Agent observation proves it.                          |
| A9  | Destructive operations are durable jobs with idempotency, fencing, audit, confirmation, and postcondition checks.                                    |
| A10 | English source text remains the i18n key. `zh-CN.json` remains the only hand-maintained localization artifact.                                       |
| A11 | Upstream is merged once into `custom/main`; CI verifies and publishes both profiles.                                                                 |
| A12 | Release tags identify source, upstream base, schemas, control-service APIs, and Agent compatibility.                                                 |
| A13 | Backup Operator remains the database backup/recovery bounded context. General stack reconciliation uses a separate Fleet control API and domain.     |
| A14 | Every mutable field has one authoritative store. Cross-store data is an immutable request, projection, or cache, never a second editable source.     |
| A15 | Production Fleet identity, registry, operation, and backup control stores stay outside every managed stack recovery domain.                          |
| A16 | Attaching a stack never transfers lifecycle ownership implicitly. Detach is the default removal action; infrastructure deletion is separate.         |

## 3. Product scope

### 3.1 Embedded Studio

Embedded Studio is the official self-hosted Studio experience with localization. It MUST:

- manage exactly one co-deployed Supabase stack;
- keep the upstream environment-variable and mounted-volume behavior;
- preserve upstream routes and self-hosted limitations;
- continue to read Edge Functions from `EDGE_FUNCTIONS_MANAGEMENT_FOLDER`;
- remain usable without the platform registry, Operator, Agent, or platform authentication stack;
- receive upstream fixes with the smallest possible semantic fork;
- expose English and Simplified Chinese through the shared i18n runtime.

Embedded Studio MUST NOT silently enable Fleet APIs merely because code exists in the same repository.

### 3.2 Fleet Studio

Fleet Studio is an independent management plane. It MUST:

- support organizations, members, roles, project registration, and project-scoped RBAC;
- register independently deployed Supabase stacks without provisioning them by default;
- route every request by `projectRef` and verify project authorization before returning sensitive data;
- discover service and management capabilities instead of assuming cloud parity;
- support agentless data-plane management when possible;
- use Fleet Control/Agent for runtime configuration, deployment, and lifecycle, and Backup Operator/Agent for physical recovery;
- expose actual, desired, degraded, and unsupported states honestly;
- support multiple Operators and Agents without global endpoint assumptions.

### 3.3 NOT in scope

The first complete Fleet release does not need to reproduce every Supabase Cloud commercial feature. In particular, it does not need to provide billing, cloud compute purchasing, cloud region provisioning, or Supabase-operated infrastructure. A cloud-only page MUST be hidden unless Fleet implements an equivalent contract.

Fleet Studio is not:

- an arbitrary remote shell;
- a generic Kubernetes dashboard;
- a replacement for Patroni or an installed PostgreSQL operator;
- a promise that every attached stack supports every action;
- a reason to modify Embedded Studio behavior.
- a system that rewrites arbitrary user-owned Compose or Kubernetes manifests;
- a reason to turn the Backup Operator into a general-purpose “god service”;
- a promise that one already-built Studio image can switch profiles at container runtime;
- a replacement for a GitOps source of truth when an attached stack is declared GitOps-managed.

## 4. What already exists and current implementation baseline

The repository already contains the following foundations:

- a platform database, platform authentication service, organizations, members, roles, invitations, and RBAC;
- `platform.projects` with encrypted database and API credentials;
- `resolveProjectConnection(ref)` as the project-scoped connection resolver;
- project-scoped pg-meta, Auth admin, Storage, REST, GraphQL, logs, metrics, and backup adapters;
- real health probes and persisted `last_health_at`;
- per-project Logflare and metrics targets;
- Docker container and Kubernetes workload identity fields;
- an all-in-one Fleet Compose deployment under `docker/self-platform/`;
- a Go Backup Operator and node-local Agent with typed tasks, durable jobs, recovery strategies, mTLS support, version negotiation, and audit foundations;
- an upstream-safe Studio localization pipeline.

These foundations are reused rather than rebuilt. Fleet work keeps the existing project resolver and direct service adapters, and extracts reusable Agent transport, fencing, event, and redaction libraries from the Backup Operator. It does **not** broaden backup-specific APIs, tables, or recovery state machines into unrelated service configuration domains.

The current `docker/self-platform/docker-compose.yml` is an all-in-one development and evaluation topology. It stores platform identity and registry data in `_platform` on the same PostgreSQL cluster as the default managed stack. That topology is **not** an acceptable production Fleet recovery boundary: restoring, corrupting, or losing the default stack can also remove the control plane needed to manage other stacks.

### 4.1 Known gaps that this architecture must close

| Area                    | Current behavior                                                                                                                             | Required target                                                                                                                         |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Project onboarding      | Runs database `select 1`, then stores `ACTIVE_HEALTHY`                                                                                       | Multi-service, permission, credential, TLS, and management-capability preflight                                                         |
| Database DSN            | One password is reused for read-write and read-only users; URI fields are directly interpolated; an encrypted DSN is returned to the browser | Server-side pg-meta proxy, structured connection fields, safe encoding, TLS, and separate credentials or one explicitly shared identity |
| Auth configuration      | Desired state is stored but not applied to GoTrue                                                                                            | Reconciled configuration with Agent apply, restart, observation, and drift reporting                                                    |
| Storage configuration   | `PATCH` echoes input without applying it                                                                                                     | Typed apply job or explicit read-only state                                                                                             |
| Realtime configuration  | `PATCH` echoes input without applying it                                                                                                     | Typed apply job or explicit read-only state                                                                                             |
| PostgREST configuration | Runtime values are global/default and updates can be no-ops                                                                                  | Per-stack observed values and Agent reconciliation                                                                                      |
| Edge Functions          | Global local filesystem artifact store, read-only in self-hosted mode                                                                        | Project-isolated remote artifact and deployment management                                                                              |
| API keys and JWT        | Registry stores copies                                                                                                                       | Coordinated generation, rotation, distribution, verification, and rollback                                                              |
| Backup Operator         | Operator URL and assertion key are global Studio settings                                                                                    | Project-to-management-target binding and per-target trust configuration; backup APIs remain backup-scoped                               |
| Metrics                 | Registry supports metrics, container, and Kubernetes identity; create form does not                                                          | Onboarding and settings UI with verification                                                                                            |
| Lifecycle               | Upgrade, branch, and network-ban routes include stubs                                                                                        | Capability-gated adapters or explicit unsupported responses                                                                             |
| UI feature checks       | `IS_PLATFORM` can expose cloud-only controls in Fleet                                                                                        | Typed profile and capability checks                                                                                                     |

No future task may add another successful no-op mutation. Until a real apply path exists, the API MUST return a stable unsupported error and the UI MUST render the setting as read-only.

The existing platform SQL migrations run automatically only on an empty data directory and currently require manual application during some upgrades. The Fleet target requires a versioned migration runner with a durable migration ledger before any rolling-upgrade claim is valid.

## 5. Source, branch, and release model

### 5.1 Long-lived branches

| Ref               | Purpose                                                                |
| ----------------- | ---------------------------------------------------------------------- |
| `upstream/master` | Read-only reference to the official Supabase repository                |
| `custom/main`     | The only long-lived customization and release integration branch       |
| `feature/*`       | Short-lived development branches merged into `custom/main`             |
| `fix/*`           | Short-lived defect branches merged into `custom/main`                  |
| `release/*`       | Optional short-lived stabilization branches; tags remain authoritative |

Do not maintain separate Embedded and Fleet development branches. That would duplicate upstream merges, localization work, security fixes, and shared Studio fixes.

### 5.2 Build outputs

Both Studio images MUST be produced from the same Git commit by separate build jobs. Next.js inlines `NEXT_PUBLIC_*` values at build time, so changing a container environment variable after build MUST NOT be documented as a way to switch an Embedded image into Fleet or vice versa.

| Output               | Profile    | Expected deployment                                                                                     |
| -------------------- | ---------- | ------------------------------------------------------------------------------------------------------- |
| `studio-embedded-zh` | `embedded` | Official-style single-stack Compose or Kubernetes deployment                                            |
| `studio-fleet`       | `fleet`    | Independent management-plane deployment                                                                 |
| `fleet-control`      | n/a        | General Fleet reconciliation API; may initially share a Go image, never a backup API namespace or store |
| `backup-operator`    | n/a        | Database backup, PITR, restore, and drill bounded context                                               |
| `stack-agent`        | n/a        | Fleet target-side executor with separately registered domain plugins                                    |

Every image MUST include OCI labels for:

- customization Git SHA;
- upstream base SHA;
- build timestamp;
- deployment profile;
- schema version where applicable;
- Fleet Control and Backup Operator API versions plus Agent protocol version where applicable.

### 5.3 Typed deployment profile

The public build-time API is:

```ts
export type StudioDeploymentProfile = 'cloud' | 'embedded' | 'fleet' | 'cli'
```

`NEXT_PUBLIC_STUDIO_DEPLOYMENT_PROFILE` is the canonical non-secret build argument. Server code MAY also read `STUDIO_DEPLOYMENT_PROFILE`, but the build MUST fail if the two values disagree. One shared resolver exposes the value to application code.

Existing booleans remain compatibility inputs during migration but MUST NOT be used directly in new feature code:

| Profile    | `NEXT_PUBLIC_IS_PLATFORM` | `NEXT_PUBLIC_SELF_PLATFORM` | Rule                                                     |
| ---------- | ------------------------- | --------------------------- | -------------------------------------------------------- |
| `cloud`    | `true`                    | not `true`                  | upstream hosted behavior                                 |
| `fleet`    | `true`                    | `true`                      | in-repository multi-project control plane                |
| `embedded` | not `true`                | not `true`                  | official-style one-stack self-hosted behavior            |
| `cli`      | existing CLI contract     | not applicable              | preserve upstream CLI detection; do not infer from Fleet |

Invalid combinations fail the build. During transition, the resolver derives a profile from the legacy pair only when the canonical profile is absent, logs a deprecation warning on the server, and profile-matrix tests lock the mapping. New UI and route code imports neither legacy boolean directly.

```ts
export interface StudioCapabilities {
  multiProject: boolean
  platformIdentity: boolean
  localFunctionsDirectory: boolean
  remoteFunctionsDeployment: boolean
  runtimeConfiguration: boolean
  lifecycleManagement: boolean
  backupManagement: boolean
  cloudManagementApi: boolean
}
```

Components MUST check a named capability such as `canDeployEdgeFunctions`, not infer support from `IS_PLATFORM`.

## 6. System architecture

### 6.1 Planes

The product separates three planes:

1. **User and control plane**: identity, organizations, RBAC, registry, desired state, operation summaries, audit, and UI.
2. **Data plane**: PostgreSQL, GoTrue, Storage, PostgREST, Realtime, Edge Runtime, gateway, logs, and metrics of each managed Supabase stack.
3. **Execution plane**: Fleet Control, Backup Operator, Agent, Kubernetes Jobs/controllers, runtime adapters, and recovery providers.

```text
Browser
  |
  v
Fleet Studio UI and BFF
  |-- platform identity, RBAC, project registry, capability projection
  |-- direct project-scoped data adapters -------------------------+
  |                                                               |
  +-- config/lifecycle request --> Fleet Control API                |
  |                                  |                              |
  +-- backup/recovery request --> Backup Operator                   |
                                     |                              |
                           durable domain jobs                      |
                                     |                              |
                              outbound mTLS                         |
                                     |                              v
                                 Stack Agent -------------> Managed Supabase stack
                                     |
                       Compose / systemd / Kubernetes adapters
```

Fleet Control and Backup Operator MAY initially be commands in one Go distribution and MAY reuse a shared Agent connection service. They MUST keep separate API namespaces, authorization policies, database schemas, migrations, retention rules, and domain packages. A failure or schema migration in generic configuration management must not corrupt backup evidence or restore plans.

### 6.2 Why the architecture is hybrid

Direct access remains the correct mechanism for low-latency operations already exposed by stable project APIs:

- SQL and database metadata;
- Auth user administration;
- Storage bucket and object operations;
- service health checks;
- log and metric queries;
- Realtime inspection.

Fleet Control/Agent or Backup Operator/Agent is required when an operation changes process configuration, files, containers, Pods, traffic, credentials, or physical database state. Studio MUST NOT obtain host-level credentials to avoid deploying an Agent.

## 7. Component responsibilities

### 7.1 Studio UI

Studio UI:

- renders profile-aware navigation;
- renders capability-aware controls and blocker reasons;
- edits desired state through typed mutations;
- displays observed state, drift, job progress, and audit evidence;
- requires explicit confirmation for destructive operations;
- never receives repository secrets, Agent private keys, database passwords, or raw runtime credentials unless an upstream-compatible screen strictly requires a project API key.

### 7.2 Studio BFF and self-platform API

The Studio backend-for-frontend (BFF):

- authenticates the user;
- resolves organization and project membership;
- enforces project-scoped RBAC;
- maps `projectRef` to data-plane endpoints and management targets;
- validates all request bodies with Zod or generated API types at the boundary;
- mints a short-lived audience-specific service assertion for Fleet Control or Backup Operator calls;
- never forwards browser authorization headers blindly to Agents;
- translates downstream failures into stable structured errors;
- emits correlation IDs and audit context.

### 7.3 Platform registry

The platform registry is the discovery and authorization index for Fleet Studio. It is not automatically the authoritative store for every execution subsystem.

Existing `platform.projects` remains the project record. The target model SHOULD normalize additional concepts into dedicated tables:

```text
platform.projects
platform.project_connections
platform.management_targets
platform.project_capabilities
platform.project_observations
platform.desired_configurations
platform.configuration_revisions
platform.operation_outbox
platform.operation_summaries
platform.audit_events
```

Every field has one authority:

| Data                                               | Authoritative store   | Copies elsewhere                                     |
| -------------------------------------------------- | --------------------- | ---------------------------------------------------- |
| Organizations, RBAC, project identity, connections | Fleet platform store  | none outside encrypted backups                       |
| Project-to-management-target bindings              | Fleet platform store  | immutable binding ID in operation requests           |
| Runtime desired configuration and revisions        | Fleet platform store  | immutable hashed snapshot in Fleet operation records |
| General operations, tasks, leases, fencing, events | Fleet control store   | summary projection in the platform store             |
| Agent enrollment and connection evidence           | Fleet control store   | non-secret capability projection in platform         |
| Backup policies, manifests, restore plans, jobs    | Backup Operator store | read-only summary projection in platform             |
| Runtime actual state                               | Managed stack         | timestamped observation/evidence in control/platform |

The platform outbox publishes an immutable request containing the desired revision and digest. Fleet Control validates that snapshot before dispatch, but cannot edit the desired document. Results update an operation summary and observed projection with compare-and-set semantics. Replaying an event therefore cannot create a second desired-state authority.

Fleet platform, Fleet control, and Backup Operator stores MUST survive restoration of any managed PostgreSQL cluster. In production they run on independent PostgreSQL clusters or managed databases with independent credentials, volumes, backups, and recovery procedures. Merely using a different database name or schema in the managed cluster is insufficient.

### 7.4 Fleet Control API and Backup Operator

Fleet Control owns general stack management:

- management-target and Agent enrollment;
- job and step persistence;
- task dispatch and reconciliation;
- leases and fencing tokens;
- configuration/lifecycle provider selection;
- retries, compensation, and manual-intervention states;
- append-only job events and audit events;
- capability and observation projection.

Backup Operator remains authoritative only for database backup, PITR, restore, isolated drill, repository maintenance, and their destructive confirmations. It keeps its existing `/v1/clusters/...` contract until a versioned backup namespace migration is planned. General Fleet APIs use `/platform/fleet/v1/...` at the Studio BFF and a distinct internal service namespace.

Neither control service requires a shell on a managed host.

### 7.5 Agent

Agent owns constrained target-side execution:

- observe service, container, Pod, filesystem, and PostgreSQL identity;
- validate enrollment identity and requested preconditions;
- apply approved configuration atomically;
- deploy project-scoped Edge Function artifacts;
- restart or roll out allowlisted services;
- execute approved backup and recovery operations;
- stream bounded progress and retain complete local evidence;
- persist idempotency and destructive-execution locks outside `PGDATA`;
- reject unknown operations, paths, containers, units, namespaces, or stale fencing tokens.

Agent MUST NOT accept a command string supplied by a user or Studio.

The shared Agent transport is infrastructure, not a license for one unversioned task schema. Each domain plugin registers typed capabilities and payload/evidence schemas under its own package and protocol compatibility policy. Unknown domain, major version, capability, or evidence schema fails closed before any side effect.

### 7.6 Deployment adapters

| Adapter            | Execution identity                                            | Main responsibilities                                                                                                                                                               |
| ------------------ | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker Compose     | Host Agent plus restricted Docker API proxy                   | Inspect known services; atomically manage a Fleet-owned override/env directory; validate `docker compose config`; restart/replace allowlisted containers; manage function artifacts |
| Kubernetes         | In-cluster controller or Agent with restricted ServiceAccount | Patch only owned fields with a dedicated field manager; manage scoped Secrets and immutable artifacts; run Jobs; roll out workloads; report Pod/PVC state                           |
| Bare metal/systemd | Host Agent with fixed helper/sudo allowlist                   | Manage allowlisted units, config files, runtime identity, backup filesystem                                                                                                         |
| Agentless          | No executor                                                   | Data-plane APIs and read-only observations only                                                                                                                                     |

Adapters implement the same typed operation contract but may advertise different capabilities.

Each stack binding declares an ownership mode per configuration domain:

- `observe-only`: report configuration and drift; never mutate runtime state;
- `direct-managed`: Fleet owns explicitly allowlisted generated files/fields and may reconcile them;
- `gitops-managed`: Fleet reports drift and emits a reviewed patch/export, but does not mutate the live resource behind the Git source of truth.

An Agent MUST NOT rewrite a user-owned Compose file or claim Kubernetes fields already owned by another manager. Conflicts become `ownership_conflict` blockers with remediation, not forced updates.

## 8. Project, management-target, and capability model

### 8.1 Project identity

`projectRef` is the stable Studio routing identity. It MUST map to exactly one Supabase stack from the user's perspective. A replacement Kubernetes workload during recovery remains the same project and changes observed workload identity only after validated cutover.

Attachment must prove and persist a stable stack fingerprint. The minimum identity combines PostgreSQL `system_identifier`, database history, and verified gateway/Auth issuer evidence; managed attachment also binds the Agent-reported deployment identity. An active fingerprint is unique across Fleet projects. A duplicate attachment fails with `stack_already_attached` unless an owner performs an audited transfer that revokes the prior binding.

A stack binding records the project ID, fingerprint, connection revision, optional management target, execution target, ownership modes, first/last verification time, and detachment state. Workload names, Pod UIDs, container IDs, and IP addresses are observations, not stack identity.

### 8.2 Management mode

```ts
export type ProjectManagementMode = 'agentless' | 'observe-only' | 'managed' | 'gitops-managed'
```

- `agentless`: direct database/service management only.
- `observe-only`: management observations are available, mutations are disabled.
- `managed`: a compatible Operator/Agent supports the requested operations.
- `gitops-managed`: Fleet observes live state and produces reviewed changes for the external source of truth.

A management target belongs to an organization and records a stable target ID, control API URL, trust-domain/audience, CA and assertion-key references, supported domain APIs, last verified versions, and disabled/revoked state. Projects bind to a target by ID; they do not copy its endpoint or signing key. Rotation creates a new key/certificate revision and supports an overlap window.

Agent enrollment uses a single-use token that is stored only as a hash, expires quickly, and is bound to organization, project, management target, execution target, deployment kind, and allowed capability prefixes. The Agent submits a CSR and observed identity; Fleet Control issues a short-lived mTLS certificate only after the token and binding match. Rotation, revocation, replay rejection, clock skew, and lost-Agent replacement are mandatory test cases.

### 8.3 Capability record

Capabilities MUST be observed and versioned, not inferred only from deployment kind.

```ts
export interface ProjectCapability {
  name: string
  state: 'available' | 'unavailable' | 'unauthorized' | 'stale' | 'unsupported'
  mode: 'direct' | 'operator' | 'agent' | 'kubernetes-job' | 'unsupported'
  source: 'static-profile' | 'preflight' | 'service-probe' | 'operator' | 'agent'
  contractVersion?: string
  targetVersion?: string
  observationRevision: string
  observedAt: string
  validUntil?: string
  blockers: Array<{
    code: string
    message: string
    remediation?: string
  }>
}
```

`blockers` is always an array on every API boundary; `null` is normalized to `[]` before schema validation. Static profile capabilities do not expire. Observed capabilities become `stale` after `validUntil`, but stale observation does not imply unsupported software. Authorization is evaluated for the requesting user after technical availability, so the UI can distinguish “not installed,” “offline,” and “you lack permission.”

Recommended capability names use stable dotted identifiers:

```text
database.metadata.read
database.sql.execute
database.config.apply
auth.users.manage
auth.config.apply
storage.objects.manage
storage.config.apply
realtime.inspect
realtime.config.apply
postgrest.config.apply
functions.read
functions.deploy
functions.secrets.apply
gateway.config.apply
backup.run
restore.plan
restore.execute
runtime.restart
runtime.upgrade
```

UI code MUST consume these capabilities through shared hooks. It MUST NOT duplicate feature inference in individual pages.

## 9. Project onboarding and connection verification

### 9.1 Onboarding stages

Fleet project creation is a staged workflow:

```text
draft
  -> validating_connection
  -> proving_stack_identity
  -> discovering_services
  -> discovering_management
  -> awaiting_confirmation
  -> attaching
  -> active | degraded | failed
```

The project MUST NOT be stored as `ACTIVE_HEALTHY` after only `select 1`.

### 9.2 Required connection inputs

The connection form must model:

- project name and unique ref;
- database host, port, database, read-write identity, and secret;
- optional separate read-only identity and secret;
- TLS mode, CA, and optional client certificate reference;
- gateway URL;
- key mode (`legacy-jwt`, `asymmetric-jwks`, or `mixed`) and the applicable anon/service-role or publishable/secret credentials;
- JWT secret only for a legacy symmetric-key deployment; JWKS issuer and key evidence for asymmetric deployments;
- optional REST override;
- optional logs and metrics targets;
- deployment kind;
- optional management-target enrollment token or existing management-target selection.
- per-domain ownership mode (`observe-only`, `direct-managed`, or `gitops-managed`).

Secrets MUST use secret references where the deployment supports them. The browser MUST never receive stored secret values after creation; edit forms use masked/write-only semantics.

### 9.3 Preflight checks

Preflight returns a structured report and MUST include:

| Check                                               | Required for active status       |
| --------------------------------------------------- | -------------------------------- |
| Database DNS/TCP/TLS                                | yes                              |
| PostgreSQL identity and major version               | yes                              |
| Stack fingerprint uniqueness and ownership proof    | yes                              |
| `select 1`                                          | yes                              |
| Required metadata and DDL permissions               | yes for full database management |
| Read-only connection                                | yes when configured              |
| Gateway reachability                                | yes                              |
| Auth health and service-role authorization          | yes for Auth capability          |
| PostgREST health and key validity                   | yes for REST capability          |
| Storage health and service-role authorization       | yes for Storage capability       |
| Realtime handshake                                  | yes for Realtime capability      |
| Edge Runtime route                                  | optional, capability-specific    |
| Logflare                                            | optional, capability-specific    |
| Metrics endpoint and workload identity              | optional, capability-specific    |
| Management-target service assertion                 | required for managed mode        |
| Agent enrollment, protocol, and build compatibility | required for Agent capabilities  |

Preflight never performs a destructive operation. It returns `pass`, `fail`, `warning`, `unsupported`, and remediation per check.

### 9.4 Status derivation

Do not store one overloaded health enum as the authority. Persist independent dimensions and derive a UI summary:

```ts
type AttachmentState = 'draft' | 'validating' | 'active' | 'detaching' | 'detached' | 'failed'
type DataPlaneHealth = 'unknown' | 'healthy' | 'degraded' | 'unreachable'
type ManagementConnectivity = 'unconfigured' | 'online' | 'offline' | 'incompatible' | 'revoked'
type DriftState = 'unknown' | 'in-sync' | 'drifted' | 'ownership-conflict'
type OperationState = 'idle' | 'active' | 'manual-intervention'
```

The project list may derive labels such as `Healthy`, `Degraded`, or `Action required`, but it MUST expose the contributing dimensions and timestamps. User input cannot directly set a healthy state, an offline Agent cannot rewrite data-plane health, and a failed optional probe cannot mark the attachment itself failed.

### 9.5 Connection update and detachment

Connection edits are staged as a new write-only connection revision. Fleet validates the candidate, atomically activates it, and retains the previous encrypted revision for a bounded rollback window. A failed candidate never replaces the active connection.

Removing a Fleet project defaults to **detach**:

1. block or resolve active destructive operations;
2. revoke enrollment tokens, Agent certificates, service assertions, and secret leases;
3. tombstone the stack binding and stop probes/reconciliation;
4. retain audit, operation summaries, and backup references according to policy;
5. delete stored connection secrets after the configured retention window.

Detach MUST NOT stop containers, delete a namespace/PVC, drop a database, or remove backup artifacts. Infrastructure deletion is a separate capability with an impact plan, explicit ownership proof, stronger confirmation, and provider-specific rollback limitations.

## 10. Desired state, observed state, and reconciliation

### 10.1 State separation

Every runtime configuration domain stores:

- desired document;
- desired generation;
- actor and timestamp;
- observed document or digest;
- observed generation;
- last reconciliation result;
- drift summary;
- secret references, never plaintext observations.

The Fleet platform store is authoritative for the desired document and revision. Saving a revision and its outbox row is one transaction. Fleet Control consumes the outbox idempotently and stores only the immutable desired snapshot/digest needed to execute and audit the operation. Observation projection back to the platform store uses the operation ID, desired revision, and compare-and-set guards so an older Agent result cannot overwrite a newer revision.

### 10.2 Reconciliation states

```text
pending -> applying -> verifying -> applied
                    \-> failed
applied + external change -> drifted
unknown executor state -> manual_intervention
```

A mutation response SHOULD return `202 Accepted` with an operation ID when target-side work is required. It MUST NOT return a final applied object before verification.

### 10.3 Configuration revision

Runtime configuration changes use optimistic concurrency:

```http
If-Match: "revision-42"
Idempotency-Key: 5f06...
```

A stale revision returns `409 configuration_conflict`. A repeated idempotency key returns the original operation.

External changes do not trigger automatic overwrite until the domain's ownership mode and drift policy allow it. `observe-only` and `gitops-managed` produce a drift report; `direct-managed` may reconcile only fields/files Fleet explicitly owns.

## 11. Typed operation protocol

### 11.1 Operation envelope

The general management protocol reuses proven Agent transport, fencing, journal, and event primitives, but it is not an extension of backup-specific API or storage contracts:

```json
{
  "operationId": "op_...",
  "taskId": "task_...",
  "projectRef": "example",
  "targetId": "target_...",
  "bindingId": "binding_...",
  "domain": "functions",
  "capability": "functions.deploy",
  "protocolMajor": 1,
  "protocolMinor": 0,
  "deadline": "2026-07-15T12:00:00Z",
  "idempotencyKey": "...",
  "fencingToken": 42,
  "expectedGeneration": 7,
  "typedInputSchema": "supabase.fleet.functions.deploy.v1",
  "preconditions": {},
  "typedInput": {}
}
```

The actual transport contract MUST be defined in Protobuf or OpenAPI-generated types. JSON above is illustrative only. Backup payloads remain under the existing `supabase.backup.*` protocol package; Fleet domains use `supabase.fleet.*`. Shared envelope fields may live in a small neutral package, but domain payloads and evidence MUST NOT be untyped byte blobs without schema/version validation at both Operator and Agent.

### 11.2 Operation classes

| Class                | Examples                                  | Confirmation                                        |
| -------------------- | ----------------------------------------- | --------------------------------------------------- |
| Observe              | discover services, read config digest     | none                                                |
| Apply configuration  | Auth, Storage, Realtime, PostgREST config | normal mutation authorization                       |
| Deploy artifact      | Edge Function deploy/delete               | authorization and immutable artifact digest         |
| Runtime lifecycle    | restart, roll out, scale                  | impact preview for service-affecting operations     |
| Credential rotation  | JWT/API keys                              | explicit plan, coordinated rollout, rollback window |
| Destructive database | PITR, replacement workload                | recent AAL2, exact plan hash, expiring confirmation |

### 11.3 Job states

Use the existing durable state model:

```text
draft -> awaiting_confirmation -> queued -> acquiring_lock -> validating
      -> running -> verifying -> succeeded

active states may enter:
cancelling -> cancelled
compensating -> failed
orphaned_execution
manual_intervention
```

External command delivery is at-least-once. Side effects are protected through idempotency records, fencing, local locks, and postcondition reconciliation. Documentation MUST NOT claim exactly-once execution.

### 11.4 Error model

Errors use stable machine codes:

```json
{
  "code": "capability_unavailable",
  "message": "Edge Function deployment is not available for this project",
  "requestId": "req_...",
  "retryable": false,
  "details": {
    "capability": "functions.deploy",
    "blockers": []
  }
}
```

Minimum shared codes:

```text
project_not_found
forbidden
validation_failed
capability_unavailable
agent_offline
protocol_incompatible
configuration_conflict
operation_conflict
precondition_failed
confirmation_required
confirmation_expired
operation_orphaned
manual_intervention_required
downstream_unavailable
downstream_invalid_response
ownership_conflict
stack_already_attached
binding_revoked
migration_required
```

## 12. Module architecture and required behavior

### 12.1 Database

Direct project-scoped pg-meta remains the primary path for SQL and metadata.

Required changes:

- construct DSNs with a structured URL builder;
- support TLS and certificate references;
- support separate read-only credentials or explicitly disable the read-only path;
- keep raw and password-derived connection material server-side in Fleet; browser calls a project-scoped BFF proxy rather than receiving `connectionString` or encrypted DSN headers;
- preflight DDL, extension, role, and metadata permissions;
- report PostgreSQL system identifier and major version;
- route parameter changes, restarts, upgrades, replicas, and physical recovery through typed providers;
- never infer lifecycle support from database reachability.

### 12.2 Auth

Auth user administration remains a direct GoTrue admin API path. Auth runtime configuration becomes reconciled desired state.

Agent apply must:

1. validate configuration and secret references;
2. render the environment/config for the deployment adapter;
3. atomically install the update;
4. perform a controlled GoTrue rollout;
5. probe health and selected behavior;
6. publish the observed generation or roll back.

The existing `platform.auth_config` table can seed desired state but is not proof that GoTrue applied it.

### 12.3 Storage

Bucket and object management remains direct through the project service key. Runtime limits, image transformation, S3 protocol, vector storage, and backend configuration require observed capabilities and Agent reconciliation.

Until apply exists, Storage settings are read-only. A no-op `PATCH` is prohibited.

### 12.4 Realtime

Realtime Inspector remains direct. Runtime limits and service settings require an Agent-supported rollout. The settings screen must show observed values, not hardcoded defaults, whenever the capability is available.

Until apply exists, Realtime settings are read-only. A no-op `PATCH` is prohibited.

### 12.5 PostgREST

SQL GRANT/REVOKE and default privileges may remain direct database operations. Runtime fields such as exposed schemas, search path, maximum rows, and pool settings require a PostgREST reconciliation capability because the self-hosted service reads environment configuration.

### 12.6 API keys and JWT signing keys

Registry values are credential references/copies, not the source of runtime truth. Rotation is a coordinated operation across GoTrue, PostgREST, Storage, Realtime, Edge Runtime, gateway configuration, and Studio.

Credential discovery and rotation MUST support legacy symmetric JWT deployments, asymmetric signing keys/JWKS, and mixed migration windows. The attach form must not require a JWT secret when the target legitimately uses asymmetric keys. Secret and publishable API keys are modeled independently from legacy anon/service-role JWTs.

Rotation must provide:

- impact plan;
- overlap strategy where supported;
- atomic or ordered rollout;
- per-service verification;
- rollback deadline;
- registry update only after verification;
- audit without secret values.

### 12.7 Edge Functions

Embedded Studio keeps the upstream mounted-directory read path.

Fleet Studio requires a project-scoped artifact model:

```text
function
deployment
immutable artifact digest
entrypoint/import map/static patterns
runtime configuration
secret references
deployment status and logs
```

Recommended Fleet flow:

```text
Studio uploads source bundle
  -> BFF validates metadata and computes digest
  -> artifact is stored in project-isolated storage
  -> Fleet Control dispatches functions.deploy
  -> Agent/controller installs or references artifact
  -> Edge Runtime rollout/reload
  -> invocation probe
  -> deployment marked active
```

The BFF rejects path traversal, symlinks that escape the bundle, oversized archives, unsupported entrypoints, and content whose digest changes during validation. Artifacts are encrypted or access-controlled by organization/project, scanned according to policy, immutable by digest, and retained independently from mutable deployment pointers.

Docker Compose uses a project-specific Fleet-owned staging directory and artifact volume. The Agent writes a new revision, verifies digest and permissions, atomically switches the active revision, performs a bounded reload/rollout and invocation probe, and restores the prior pointer on failure. It does not overwrite the user's source checkout.

Kubernetes uses an immutable artifact reference delivered through an object store, image, CSI/PVC, or init-container strategy appropriate to the installation. Large function bundles MUST NOT be placed in ConfigMaps. The controller updates an owned deployment revision, waits for rollout/probe evidence, and rolls back the revision pointer when safe. The central Studio filesystem MUST NOT be the artifact store for attached projects.

### 12.8 Gateway

Gateway URL is sufficient for data-plane access but not gateway management. Fleet gateway management requires adapter capabilities for:

- route and upstream discovery;
- TLS and domain references;
- key-auth/JWT synchronization;
- CORS and request-size policy;
- rate limiting;
- maintenance/write fencing;
- safe reload and rollback.

Gateway changes are not part of the database connection form unless a compatible Agent is enrolled.

### 12.9 Logs and metrics

Logflare and Prometheus-compatible targets remain project-scoped. Onboarding/settings must expose and verify:

- logs base URL and write-only token;
- metrics scrape URL and write-only token;
- Docker container identity;
- Kubernetes namespace, Pod selector, and container identity;
- freshness and last successful sample.

Missing optional observability must yield an explicit unconfigured state, not a page-level error.

### 12.10 Backup and PITR

The Go Backup Operator architecture remains authoritative for physical backup and recovery. Fleet integration must change from one global Operator URL to a project-to-management-target binding.

The binding references the Backup Operator domain endpoint and trust record exposed by the selected management target. Backup policies, manifests, restore plans, jobs, fencing, and evidence remain in the Backup Operator store; Fleet Control may not copy them into its general job tables as editable state.

Restore continues to require:

- independent Backup Operator control store;
- fresh topology and repository evidence;
- write fencing;
- recoverability plan;
- AAL2;
- exact expiring plan hash;
- version-pinned Agent capability;
- durable progress and manual-intervention handling.

### 12.11 Lifecycle, upgrade, replicas, and branching

These are independent capabilities, not implied Fleet features. Stub routes must be removed, hidden, or replaced by stable unsupported responses until a provider exists.

Provider support is evaluated against the discovered versions and configuration of PostgreSQL, GoTrue, PostgREST, Storage, Realtime, Edge Runtime, gateway, deployment adapter, Fleet Control, Backup Operator, and Agent. Releases publish and test a target-version compatibility matrix; deployment kind alone never enables a lifecycle capability.

Potential provider capabilities:

```text
runtime.restart
runtime.rollout
runtime.scale
postgres.upgrade.plan
postgres.upgrade.execute
replica.create
replica.remove
branch.create
branch.restore
network.bans.read
network.bans.update
```

## 13. Security architecture

### 13.1 Trust boundaries

- Browser trusts Studio over HTTPS and holds only a user session.
- Studio trusts platform identity and the registry.
- Fleet Control and Backup Operator trust short-lived Studio service assertions with user, organization, project, binding, permissions, AAL, audience, nonce, expiry, and request ID.
- Agent trusts the enrolled control service through mTLS and a pinned trust domain.
- Target adapters trust only enrolled resource identities and allowlists.

Network reachability is never authorization.

### 13.2 Least privilege

Prohibited configurations:

- Docker socket mounted into Internet-facing Studio, Fleet Control, or Backup Operator;
- arbitrary SSH execution from Studio;
- cluster-admin Kubernetes credentials in Studio;
- arbitrary `sudo`, `systemctl`, filesystem path, container name, namespace, or command input;
- secrets in task payload logs, audit payloads, URLs, or command arguments.

Use fixed helper binaries, restricted socket proxies, scoped ServiceAccounts, and enrollment-time allowlists.

Fleet browser responses MUST NOT contain database DSNs, password-derived encrypted DSNs, Operator assertion keys, Agent credentials, repository credentials, or long-lived service-role credentials. The current `connectionString` response is a transition gap: encrypted DSN material behaves like a bearer credential to pg-meta and must be removed from Fleet responses. A project-scoped BFF proxy resolves secrets only after authorization and sends them directly to the downstream service. Embedded Studio may retain upstream-compatible transport behavior inside its one-stack trust boundary.

### 13.3 Secret storage

- Platform registry secrets remain encrypted at rest.
- New designs MUST use envelope encryption with a versioned key ID and tested rotation/recovery procedure.
- Secret edit fields are write-only and masked.
- Production deployments SHOULD store secret values in a supported external secret manager and persist only references where possible; the encrypted database provider remains available for self-contained deployments.
- Repository credentials and destructive job state live in the independent Backup Operator store.
- Agent receives short-lived credentials when possible.
- Secret values are redacted recursively before logging.
- Platform encryption keys, identity signing keys, control-service assertion keys, Agent CA keys, and their backups MUST be outside every managed stack recovery domain. Recovery drills include key availability and rotation overlap, not only database restoration.

### 13.4 Authorization classes

| Action                      | Minimum policy                                                      |
| --------------------------- | ------------------------------------------------------------------- |
| Read project status         | project read permission                                             |
| Modify data through Studio  | existing database/Auth/Storage permission                           |
| Apply runtime configuration | project administrator or dedicated infrastructure-config permission |
| Restart or roll out service | infrastructure execute permission                                   |
| Run backup                  | backup management permission                                        |
| Plan restore                | infrastructure execute permission                                   |
| Confirm/execute restore     | owner plus recent AAL2 and exact plan confirmation                  |
| Release manual lock         | owner plus audit reason                                             |

### 13.5 Audit

Every state-changing management action records actor, organization, project, source session/request, normalized redacted input, previous/desired generation, operation type, target identity, timestamps, result, and manual override reason.

## 14. Reliability and failure semantics

- The owning control service commits state before dispatching side effects.
- Dispatch uses a transactional outbox.
- Agent deduplicates task IDs and idempotency keys.
- Agent persists destructive locks outside managed database storage.
- Heartbeat loss does not authorize destructive replay.
- Unknown destructive state becomes `orphaned_execution` or `manual_intervention`.
- Every adapter implements postcondition inspection.
- Configuration apply either verifies the new generation or reports failure/drift.
- UI reconnects to event streams with a cursor and can fall back to a durable snapshot.
- Optional services degrade independently; one optional probe does not make the whole project unavailable.
- Probes, reconciliation, event delivery, and Agent heartbeats use jitter, bounded concurrency, deadlines, circuit breakers, and per-target backoff. One offline stack cannot consume the control-plane worker pool.
- Organization and management-target quotas bound concurrent operations, queued work, artifact bytes, log/metric query fan-out, and Agent sessions.
- Control-store and platform-store disaster recovery is tested independently of managed-stack recovery, including encryption and CA key restoration.

### 14.1 Initial tested capacity envelope

The architecture does not claim unlimited scale. The first production release MUST publish the tested envelope and test at least:

- 100 attached projects and 300 connected Agents per Fleet control-plane installation;
- 20 concurrent target-side operations, with a configurable lower per-target limit;
- 10,000 retained operation events per active operation before archival/compaction;
- project-list and cached capability reads at p95 below 500 ms inside the control plane, excluding a live downstream probe;
- newly committed operation events visible to the UI within 5 seconds under the tested load;
- reconnect storms with randomized Agent backoff and no loss of durable task/result state.

Probe and metrics collection MUST batch registry reads, limit downstream fan-out, cache capability snapshots by project and observation revision, and avoid N+1 queries on project lists. Limits are configuration with safe maxima; increasing them requires a new load-test result and capacity note.

## 15. Observability standard

All Fleet requests and jobs use:

- `request_id`;
- `correlation_id`;
- `project_ref` or stable internal project ID;
- `operation_id`;
- `task_id` and `step_id` where applicable;
- stable internal target and Agent IDs.

Do not use user input, project/target/Agent IDs, error messages, job IDs, or repository paths as Prometheus labels. High-cardinality identity belongs in structured logs, traces, and sampled exemplars.

Minimum management metrics:

```text
fleet_projects_total{management_mode,status}
fleet_project_probe_success{service}
fleet_project_probe_age_seconds{service}
fleet_operations_total{type,state}
fleet_operation_duration_seconds{type}
fleet_agents_total{state,adapter,protocol_major}
fleet_agent_heartbeat_age_seconds{adapter}
fleet_reconciliation_drift{domain}
fleet_reconciliation_failures_total{domain,code}
fleet_event_backlog
```

Logs and event payloads must pass secret redaction tests.

## 16. Studio development standard

### 16.1 Code location

- Profile-independent UI stays in existing upstream locations.
- Fleet server logic lives under `apps/studio/lib/api/self-platform/`.
- Fleet BFF routes remain under `apps/studio/pages/api/platform/` while the Pages Router is active; new management APIs use a stable `/platform/fleet/v1/` namespace rather than borrowing hosted cloud paths.
- Profile/capability primitives live in one low-churn shared module such as `apps/studio/lib/constants/deployment-profile.ts` and are exposed through shared hooks.
- Target-side execution belongs in Fleet Control, Backup Operator, and Stack Agent Go domains, not Next.js API handlers.
- Deployment manifests remain under `docker/self-platform/`, `apps/backup-operator/deploy/`, and a dedicated Fleet Control deployment directory when introduced.

### 16.2 Upstream-change discipline

Prefer, in order:

1. new Fleet-owned files;
2. narrow adapter calls at stable upstream seams;
3. capability checks through shared hooks;
4. direct edits to high-churn upstream components only when unavoidable.

Fleet-specific edits in upstream-owned files should carry a concise `// [self-platform]` rationale when the reason is not obvious. Do not copy entire upstream components into Fleet forks.

### 16.3 React and TypeScript

- Use React Query for server state.
- Define query keys by `projectRef` and every identity that changes the result.
- Use `react-hook-form` and Zod for forms and API boundaries.
- Use explicit loading, error, empty, success, unsupported, and degraded states.
- Use named booleans with `is`, `has`, `can`, or `should` prefixes.
- Derive state instead of duplicating it in `useState`.
- Split components around 200–300 lines when they contain independent sections.
- Avoid `as any`; validate unknown downstream responses.
- Use shared UI primitives and semantic Tailwind tokens.
- Use the shared shortcut registry for repeated Studio actions.

### 16.4 Query and mutation rules

- Every Fleet query includes `projectRef` in its key and request.
- A missing `projectRef` fails before a network request.
- Mutations invalidate only affected project/domain keys.
- Long-running mutations return an operation and subscribe/poll separately.
- Default mutation error handling uses stable codes and localized user messages.
- Retry only safe, idempotent operations.
- Never retry destructive actions in the browser.

### 16.5 API rules

- Authenticate first; resolve only non-secret project identity/existence second; authorize membership/action third; decrypt connection secrets and access downstream data fourth.
- Preserve non-enumerating 404 behavior after authentication without decrypting project secrets. A registry lookup and a connection-secret resolution are separate operations.
- Validate request and downstream response schemas.
- Do not call `response.json()` blindly. Check status and content type, handle empty/non-JSON bodies, and map malformed downstream responses to `downstream_invalid_response` with a request ID.
- Response collections such as `blockers`, events, and capabilities are non-null arrays. Stable defaults are produced server-side before validation; required progress/manual-intervention fields are versioned rather than added silently.
- Use generated OpenAPI/Protobuf contracts for Fleet Control, Backup Operator, and Agent boundaries.
- Do not return secrets unless the API contract explicitly requires them and RBAC permits them.
- Do not use global environment fallback for a registered non-default Fleet project.
- No successful no-op mutations.
- Stable error code is required for every expected failure mode.

### 16.6 Go rules

- Orchestration depends on capability-oriented interfaces, not command strings.
- Use `exec.CommandContext` without a shell for allowlisted binaries.
- Typed input is validated in the owning control service and Agent.
- External side effects require preconditions and postcondition checks.
- Every provider has contract tests.
- Destructive tasks persist local execution identity and non-takeover state.
- Context cancellation, deadlines, bounded buffers, and redaction are mandatory.
- Build and protocol versions participate in capability negotiation.

### 16.7 Database migration rules

- Migrations are additive and idempotent during rolling compatibility windows.
- New nullable fields are preferred before backfill and constraint tightening.
- Application code tolerates one previous schema version during rollout.
- Encrypted fields use a clear `_enc` or secret-reference convention.
- JSONB is acceptable for provider-specific metadata, not for core searchable state.
- Every migration includes rollback/forward-repair guidance and tests against existing data.
- Fleet platform, Fleet control, and Backup Operator each own an independent schema version and migration ledger.
- A migration runner verifies ordered checksums, acquires an advisory lock, records success transactionally, and refuses readiness when required migrations are missing or changed.
- Production upgrades MUST NOT depend on manually piping individual SQL files into a running database.

## 17. Localization and upstream synchronization

### 17.1 Localization architecture

- English source string is the translation key.
- There is no `en.json`.
- `apps/studio/lib/i18n/locales/zh-CN.json` is the durable translation artifact.
- Missing translations fall back to English.
- Source wrapping is regenerated by the idempotent codemod.
- New user-facing Fleet text MUST use the existing `$t` path and MUST be added to the catalog workflow.

### 17.2 Scheduled upstream sync

The synchronization automation runs weekly and additionally on a selected upstream security/release trigger. It creates a short-lived `sync/upstream-YYYYMMDD` branch and pull request against `custom/main`; it never merges conflict resolutions or translation changes directly into the release branch. A critical upstream security fix is triaged within one business day rather than waiting for the weekly run.

The synchronization job runs once per candidate against `custom/main`:

```bash
./apps/studio/scripts/i18n/sync-upstream.sh upstream/master
```

Required gates after conflict resolution and translation:

```bash
pnpm --filter studio exec vitest run lib/i18n scripts/i18n
pnpm --filter studio exec tsc --noEmit -p tsconfig.json
pnpm build --filter=studio
```

The sync must preserve `I18nProvider` in `pages/_app.tsx` and `LanguageSwitcher` in `UserDropdown.tsx`. Those activation points are manually protected by the sync script.

### 17.3 Sync CI matrix

Every upstream-sync candidate must pass:

1. i18n tests and production build;
2. an Embedded build with the explicit `embedded` profile and Embedded unit/smoke tests;
3. a separate Fleet build with the explicit `fleet` profile and Fleet unit/API contract tests;
4. Fleet Compose smoke test;
5. Fleet Control and Backup Operator build, tests, vet, OpenAPI, and Protobuf generation checks;
6. selected destructive E2E tests only in an isolated disposable environment.

## 18. Testing strategy

### 18.1 Test layers

| Layer                         | Purpose                                                                                            |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| Pure unit                     | capability derivation, validation, state machines, redaction, parsers                              |
| Studio network-mock component | loading/error/degraded/unsupported UI and mutation behavior                                        |
| API handler                   | authentication, RBAC, project isolation, schema validation, error mapping                          |
| Contract                      | OpenAPI/Protobuf compatibility and provider conformance                                            |
| Integration                   | real platform PostgreSQL, pg-meta, GoTrue, Storage, Logflare, metrics, Fleet/backup control stores |
| Embedded E2E                  | official single-stack behavior remains unchanged except localization                               |
| Fleet E2E                     | two-project isolation, onboarding, capability gating, Agent reconciliation                         |
| Destructive E2E               | backup, PITR, rollback, orphan handling, replacement workload                                      |

### 18.2 Required isolation tests

Every project-scoped feature must prove:

- project A cannot read or mutate project B;
- cache/query keys do not leak results between refs;
- service credentials are selected from the requested project;
- global fallback is not used for non-default registered refs;
- a missing capability never exposes an enabled control;
- audit records contain the correct project and actor.

### 18.3 Profile regression tests

Every Fleet change touching shared Studio code must add or update a zero-break Embedded test. Every upstream sync must build both profiles from the same commit.

### 18.4 Destructive test requirements

Destructive workflows require failure injection at every irreversible boundary:

- owning control-service restart before and after dispatch;
- Agent disconnect before and after process start;
- duplicate delivery;
- stale fencing token;
- disk full;
- repository unavailable;
- topology change after plan;
- expired AAL2 or confirmation;
- failed postcondition;
- rollback deadline expiration.

### 18.5 Required code-path and user-flow coverage

The implementation plan is incomplete unless every branch below has unit/contract coverage and every marked flow has integration or E2E coverage:

```text
PROFILE BUILD                                   FLEET ATTACH [E2E]
profile input                                   authenticated request
  |-- canonical valid -> resolved                 |-- invalid/mismatched org -> deny
  |-- legacy pair -> transition warning           |-- connection/TLS/key failure -> failed report
  |-- invalid combination -> build fails          |-- duplicate fingerprint -> block/transfer
  `-- Embedded/Fleet bundles -> isolation test     `-- confirmed binding -> active dimensions

DIRECT DATA BFF [E2E]                           CONFIG RECONCILIATION [E2E]
authenticate                                      save desired + outbox transaction
  -> non-secret lookup                              -> idempotent control consume
  -> authorize                                      -> binding/capability/ownership guards
  -> decrypt server-side                            -> Agent typed apply
  -> downstream call                                -> postcondition evidence
  `-> redact/map response                            `-> CAS observed projection or stale discard

EDGE FUNCTION DEPLOY [E2E]                       BACKUP/RESTORE [DESTRUCTIVE E2E]
validate bundle -> immutable artifact              BFF authorization/AAL
  -> typed dispatch -> stage revision                -> Backup Operator plan/confirm/job
  -> atomic activate -> rollout/probe                 -> Agent fenced execution/evidence
  `-> rollback pointer or manual intervention         `-> durable status during target outage

DETACH [E2E]
active-operation guard -> revoke enrollment/secrets -> tombstone binding
  |-- retain audit/backup references
  `-- prove managed infrastructure was not deleted
```

Planned test locations:

- `apps/studio/tests/lib/constants/deployment-profile.test.ts` for the complete profile/legacy matrix;
- `apps/studio/tests/pages/api/platform/projects/` for attach, duplicate identity, connection revision, RBAC, and detach handlers;
- `apps/studio/tests/pages/api/platform/pg-meta/` for server-side credential proxy and cross-project isolation regressions;
- `apps/studio/tests/lib/api/self-platform/` for outbox, status derivation, capability normalization, and stale observation CAS;
- `apps/studio/tests/components/interfaces/` for unsupported, stale, offline, unauthorized, drift, and manual-intervention UI;
- `apps/backup-operator/internal/...` for unchanged backup protocol/recovery behavior and shared-transport extraction regressions;
- planned Fleet Control Go packages for provider contracts, enrollment, outbox consumption, evidence validation, and backpressure;
- `e2e/studio/` for Embedded zero-break, two-project Fleet isolation, attach/detach, reconciliation, and Edge Function flows;
- isolated disposable Compose/Kubernetes harnesses for restore and runtime mutation.

### 18.6 Production failure-mode acceptance matrix

| Flow                   | Realistic failure                                      | Required test/error handling/user result                                                        |
| ---------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Profile build          | legacy flags contradict canonical profile              | build test; fail before image publish with the conflicting values named                         |
| Attach                 | same stack is attached under another ref               | integration test; `stack_already_attached`; show transfer/detach remediation                    |
| Direct BFF             | user loses permission after page load                  | API/E2E test; deny before secret decryption; localized authorization error                      |
| Connection update      | candidate works once then fails verification           | integration test; keep old revision active; show candidate failure and retry                    |
| Desired-state dispatch | platform commits outbox while Fleet Control is offline | restart test; durable retry/backoff; show queued/degraded state                                 |
| Agent task             | old result arrives after a newer revision              | CAS test; discard stale observation; show latest operation only                                 |
| Edge Function deploy   | rollout probe fails after artifact activation          | E2E failure injection; restore pointer or enter manual intervention with exact remediation      |
| Backup inventory       | managed PostgreSQL is intentionally offline in restore | destructive E2E; serve durable manifests as stale; do not hide recovery evidence                |
| Detach                 | Agent is offline while certificate must be revoked     | E2E test; revoke centrally and tombstone; show target-side cleanup pending without deleting it  |
| Control-plane recovery | platform DB restored without encryption/CA keys        | DR drill must fail readiness clearly; documented key recovery path; no silent partial operation |
| Agent reconnect storm  | hundreds of Agents retry simultaneously                | load test; jitter/backpressure; UI remains available and durable tasks are not duplicated       |

## 19. Delivery and release standard

### 19.1 Pull request requirements

Each feature PR states:

- affected profile(s);
- capability names added or changed;
- API/schema/protocol compatibility;
- security and secret impact;
- tests run for Embedded and Fleet;
- UI behavior when unsupported or degraded;
- migration and rollback plan;
- localization keys added;
- upstream conflict surface.

### 19.2 Release compatibility

A Studio platform release tag (for example `studio-platform/vX.Y.Z`) identifies one source commit and publishes both `studio-embedded-zh:X.Y.Z` and `studio-fleet:X.Y.Z`. Fleet Control, Backup Operator, and Stack Agent may version independently because their rollout cadence differs, but the Studio release includes a signed compatibility manifest that pins their supported ranges. Moving a floating `latest` tag is not release evidence.

Publish a compatibility manifest with:

```json
{
  "studio": "...",
  "profile": "fleet",
  "fleetControlApi": "v1",
  "backupOperatorApi": "v1",
  "agentProtocolMajor": 1,
  "minimumAgentBuild": "...",
  "platformSchema": 12,
  "fleetControlSchema": 1,
  "backupControlSchema": 14,
  "supportedAdapters": ["agentless", "compose", "kubernetes", "systemd"]
}
```

Minor protocol differences may negotiate capabilities. Major differences fail closed. A destructive plan pins the Agent build and capability snapshot used during confirmation.

### 19.3 Release gates

- both Studio profiles build from the same commit;
- each Studio profile is compiled in its own job with its canonical build-time profile and legacy-flag compatibility assertions;
- Embedded behavior passes official-style self-hosted smoke tests;
- Fleet multi-project isolation passes;
- generated contracts are clean;
- migrations pass fresh and upgrade paths;
- images are scanned and signed;
- checksums reference downloadable artifact names;
- documentation and runbooks match the shipped flags;
- no high-confidence credentials appear in staged or built artifacts.

## 20. Implementation roadmap

### Phase 0: product-profile correctness

Deliver:

- typed deployment profile;
- canonical/legacy flag validation and separate Embedded/Fleet image builds;
- shared capability registry and hooks;
- removal of new direct `IS_PLATFORM` Fleet inference;
- hidden/disabled cloud-only and unsupported controls;
- replacement of successful no-op mutations with explicit unsupported behavior.

Exit gate: Embedded and Fleet navigation show only truthful features.

### Phase 1: honest onboarding

Deliver:

- staged attach workflow;
- structured database connection and TLS fields;
- separate read-only credentials;
- server-side pg-meta proxy and removal of Fleet browser `connectionString`/encrypted DSN exposure;
- legacy/asymmetric/mixed key-mode discovery;
- stable stack fingerprint, duplicate-attachment protection, and ownership proof;
- multi-service preflight;
- capability report;
- independent attachment, data-plane, management, drift, and operation states;
- staged connection revision update and non-destructive detach;
- logs, metrics, container, and Kubernetes identity inputs.

Exit gate: invalid gateway/keys cannot create a healthy project, a duplicate stack cannot be silently attached twice, and no Fleet browser response contains database connection material.

### Phase 2: management-target and Agent enrollment

Deliver:

- independent production stores for platform identity/registry, Fleet Control, and Backup Operator;
- versioned platform migration runner and single-authority/outbox schemas;
- Fleet Control bounded context separated from backup APIs/store while reusing neutral transport libraries;
- organization management targets and project stack bindings;
- multiple Fleet Control/Backup Operator endpoints and trust domains;
- bound single-use enrollment tokens, CSR issuance, certificate rotation, and revocation;
- Agent heartbeat/protocol/capability projection;
- Compose, Kubernetes, systemd, and agentless adapters.

Exit gate: two projects can bind to different control targets/Agents without global configuration, and restoring the default managed stack cannot remove platform identity, registry, operation, or backup control state.

### Phase 3: configuration reconciliation

Deliver:

- desired/observed revisions;
- transactional desired-state outbox and stale-result compare-and-set projection;
- `observe-only`, `direct-managed`, and `gitops-managed` ownership policies;
- Auth apply;
- Storage apply;
- Realtime apply;
- PostgREST apply;
- drift detection, rollback, and audit.

Exit gate: a Studio save is either verified applied or visibly failed/drifted.

### Phase 4: Edge Functions management

Deliver:

- project-isolated artifact storage;
- deploy/update/delete APIs;
- atomic Compose revision/pointer and immutable Kubernetes artifact adapters;
- function secret reconciliation;
- versions, logs, invocation probe, and rollback.

Exit gate: functions from one project cannot appear in or deploy to another project.

### Phase 5: coordinated credentials and gateway

Deliver:

- JWT/API-key rotation plan;
- legacy/asymmetric/mixed signing-key compatibility;
- multi-service rollout and overlap handling;
- gateway discovery/config adapters;
- maintenance/write-fence integration;
- rollback and audit.

Exit gate: rotation succeeds or rolls back without leaving registry/runtime divergence.

### Phase 6: lifecycle providers

Deliver according to capability priority:

- restart and rollout;
- scale;
- PostgreSQL upgrade planning/execution;
- replica lifecycle;
- network policy/bans;
- optional branching.

Exit gate: every advertised lifecycle action has impact preview, durable job state, verification, and rollback/manual recovery instructions.

### Phase 7: production hardening

Deliver:

- HA Fleet Control and Backup Operator deployments;
- disaster recovery for platform, Fleet Control, and Backup Operator stores and their key material;
- certificate and encryption-key rotation;
- capacity and performance tests;
- alert rules and SLOs;
- upgrade compatibility matrix;
- control-service, Agent, and project detachment runbooks;
- audit, operation-event, artifact, tombstone, and secret-retention policies.

### 20.1 Worktree parallelization strategy

| Workstream                         | Primary modules                                                 | Depends on              |
| ---------------------------------- | --------------------------------------------------------------- | ----------------------- |
| Profile and Embedded isolation     | `apps/studio`, Studio image/CI                                  | none                    |
| Fleet secret-safe BFF/onboarding   | `apps/studio/lib/api/self-platform`, platform routes/migrations | profile primitives      |
| Fleet Control foundation           | planned Go control packages, shared Agent transport             | authority contracts     |
| Production control-plane topology  | `docker/self-platform`, deployment manifests/runbooks           | store contracts         |
| Reconciliation providers           | Fleet Control and Agent domain plugins                          | control foundation      |
| Edge Functions artifact management | Studio functions APIs, artifact store, Agent adapters           | control + onboarding    |
| Backup target binding              | Studio backup adapter, `apps/backup-operator`                   | management-target model |
| UI capability/state presentation   | `apps/studio/components`, query hooks, i18n                     | profile + API contracts |

Parallel lanes:

- Lane A: profile primitives → Embedded/Fleet build matrix.
- Lane B: authority schema → secret-safe onboarding → management-target bindings.
- Lane C: neutral Agent transport extraction → Fleet Control foundation → reconciliation providers.
- Lane D: production control-plane deployment → DR/runbooks.
- Lane E: UI state model and localization, starting after profile/API types stabilize.

Launch A, the authority-contract portion of B, and the transport-boundary portion of C in parallel. Merge their contracts before continuing with onboarding, reconciliation, Edge Functions, or UI flows. Lane D can proceed after store contracts stabilize. Backup target binding and Edge Functions can then run in parallel because they remain separate domains. Avoid parallel changes to shared generated contracts, platform migrations, or shared Agent protocol packages without a designated owner; those are explicit merge-conflict zones.

## 21. Implementation Tasks

Synthesized from the engineering review. Checkbox each task as it ships; priorities describe architectural release gates, not the current documentation-only change.

- [x] **T1 (P1)** — Studio profiles — Implement canonical build-time deployment profile, legacy mapping, invalid-combination failure, and two-image CI matrix.
  - Surfaced by: architecture review — current `NEXT_PUBLIC_*` flags are inlined at build time.
  - Files: `apps/studio/lib/constants/`, `apps/studio/Dockerfile`, Studio CI/release workflows.
  - Verify: full profile unit matrix plus separate production builds and Embedded/Fleet smoke tests.
  - Implemented: 2026-07-15 — canonical resolver and static capability baseline, legacy compatibility validation, explicit Embedded/Fleet Docker build arguments and OCI profile labels, two-profile CI/release matrices, and profile-specific container smoke assertions. No ADR change was required.
- [x] **T2 (P1)** — Fleet credential boundary — Remove Fleet browser `connectionString`/encrypted DSN responses and proxy pg-meta server-side after RBAC.
  - Surfaced by: security review — current project responses expose password-derived pg-meta bearer material.
  - Files: `apps/studio/lib/api/self-platform/resolve-connection.ts`, project/pg-meta API routes, dependent data hooks.
  - Verify: network tests prove no DSN material in responses and cross-project/permission failures occur before decryption.
  - Implemented: 2026-07-15 — split non-secret project identity lookup from credential resolution; Fleet project and database responses omit both read-write and read-only encrypted DSNs; browser pg-meta middleware strips legacy connection headers; all Fleet pg-meta listing/query routes authorize before server-side credential injection; connection-dependent hooks remain enabled under the server-side BFF contract. Unit/network suites cover response redaction, forged-header replacement, deny-before-resolution ordering, project isolation, and unchanged Embedded response/transport behavior. No ADR change was required.
- [x] **T3 (P1)** — Control-plane recovery boundary — Deploy platform identity/registry, Fleet Control, and Backup Operator stores outside managed-stack recovery domains.
  - Surfaced by: architecture review — current all-in-one Compose stores `_platform` in the default managed cluster.
  - Files: `docker/self-platform/`, Fleet/backup deployment manifests, production runbooks.
  - Verify: stop/restore the default managed stack while login, registry, durable operation state, and backup evidence remain available.
  - Implemented: 2026-07-15 — added a production-only independent Fleet control-plane Compose project with separate platform, reserved Fleet Control, and PostgreSQL Backup Operator recovery domains; changed Backup Operator Compose/Helm/Kustomize production manifests from local SQLite/PVC state to an external or dedicated PostgreSQL store; added a destructive managed-stack outage acceptance drill and production recovery/upgrade guidance. The existing all-in-one Compose remains explicitly development/evaluation-only. Fleet Control API/schema work remains T4, so T3 provisions but does not claim use of its reserved store. No ADR change was required; this implements ADR-006, ADR-009, and ADR-011.
- [x] **T4 (P1)** — Bounded controls — Introduce Fleet Control as a separate API/store domain and extract only neutral Agent transport/fencing/event libraries from Backup Operator.
  - Surfaced by: code-quality review — the document previously overloaded a backup-specific service with all stack management.
  - Files: `apps/backup-operator`, planned Fleet Control Go packages, generated contracts.
  - Verify: independent schema/API compatibility tests and unchanged backup/restore regression suite.
  - Implemented: 2026-07-15 — added a separate `fleet-control` binary, `/platform/fleet/v1/...` OpenAPI contract, `supabase.fleet.*` typed Agent protocol, independent SQLite/PostgreSQL store migrations, project-scoped service-assertion RBAC, immutable operation/audit/event records, and capability-fail-closed behavior. Backup Operator keeps its existing `/v1/clusters/...` API, `supabase.backup.*` protocol, store, and recovery state machines; only protocol-neutral dispatch validation, fencing allocation, and bounded event replay moved into shared packages. Production Compose now runs Fleet Control against the T3-reserved independent PostgreSQL recovery domain. T5 remains responsible for platform desired-state outbox/CAS and the checksum-locked migration runner; T7 remains responsible for management-target enrollment and certificate lifecycle. No ADR change was required; this implements ADR-007, ADR-009, ADR-010, and ADR-011.
- [x] **T5 (P1)** — Authority and migrations — Implement authoritative platform desired state, transactional outbox, immutable control snapshots, CAS observations, and versioned migration runner.
  - Surfaced by: architecture review — desired state and operations previously had competing implied owners.
  - Files: platform migrations/API, Fleet Control store/migrations, operation queries.
  - Verify: restart/replay/stale-result integration tests and fresh/upgrade/changed-checksum migration tests.
  - Implemented: 2026-07-15 — added the platform-owned desired configuration/revision authority, atomic operation outbox and summary projection, immutable revision/outbox payload guards, leased idempotent dispatcher, and revision/generation CAS observation projection. Platform and Fleet Control migration runners now use ordered SHA-256 ledgers, PostgreSQL advisory locks, transactional application, changed/removed-file rejection, and readiness gates; Fleet Control schema 2 persists and verifies the platform revision, digest, and canonical snapshot before accepting an operation. Production Compose provisions a least-privilege outbox dispatcher identity and blocks Studio/Auth startup on platform migration completion. Focused Studio/Go tests plus a disposable Compose acceptance cover RBAC/project isolation, Embedded API isolation, legacy upgrade, concurrent fresh migration, replay, stale observation rejection, and checksum tampering. T7 still owns real project-to-management-target binding and T8 owns executable providers, so T5 does not advertise or fake configuration apply. No ADR change was required; this implements ADR-004, ADR-009, ADR-010, and ADR-011.
- [x] **T6 (P2)** — Honest attachment — Add stack fingerprint proof, duplicate protection, key modes, multi-service preflight, independent status dimensions, staged connection update, and detach.
  - Surfaced by: architecture and test review — `select 1` currently yields `ACTIVE_HEALTHY` and delete semantics are too broad.
  - Files: project admin/connection/health APIs, platform schema, New Project and project settings UI.
  - Verify: two-project E2E including duplicate, asymmetric keys, stale session, failed candidate, offline Agent, and no-infrastructure-delete detach.
  - Implemented: 2026-07-15 — Fleet project creation now performs database identity/permission probes plus Gateway, Auth, REST, Storage, Realtime, and JWKS checks before persisting a binding; a stable database/gateway/Auth fingerprint and partial unique index prevent duplicate active attachments. Legacy JWT, asymmetric JWKS, and mixed credentials, explicit TLS modes/CA references, and optional independent read-only credentials are stored only as encrypted server-side connection revisions. Connection edits create a validating candidate and preserve the active revision on failure; successful candidates activate atomically with a 24-hour rollback revision. Attachment, data-plane health, management connectivity, drift, and operation dimensions are projected independently with timestamped capabilities and blockers. Fleet creation, status, connection update, and detach routes enforce canonical Fleet profile, static profile capability, project capability, project-scoped RBAC, and organization/project isolation before credential access. Detach is an audited tombstone operation that schedules secret purge and offline cleanup while preserving managed infrastructure and history. Embedded routing and behavior remain unchanged. Focused unit/API/MSW tests plus a disposable two-project Compose acceptance cover duplicate binding, asymmetric/JWKS evidence, stale sessions, candidate failure, offline management, and non-destructive detach. No ADR change was required; this implements ADR-003, ADR-012, and ADR-014. See [T6 honest attachment operations](./2026-07-15-t6-honest-attachment-operations.md).
- [x] **T7 (P2)** — Management trust — Implement organization management targets, project bindings, single-use enrollment, CSR/mTLS rotation/revocation, and per-domain capability schemas.
  - Surfaced by: security review — global Operator URL/key and underspecified enrollment cannot safely support multiple control domains.
  - Files: platform schema/routes, Fleet Control enrollment, Agent bootstrap, Studio settings UI.
  - Verify: replay, wrong binding, expired token, revoked certificate, protocol mismatch, and two-target isolation tests.
  - Implemented: 2026-07-15 — added organization-owned management targets and per-domain HTTPS/audience/schema contracts, one active project binding with organization/project/target/execution/deployment/prefix isolation, and server-side secret references rather than browser-visible control material. Fleet Control schema 3 stores only enrollment-token hashes, validates single-use and expiry atomically, accepts Agent-generated CSR over a CA-pinned TLS enrollment listener, issues short-lived SPIFFE mTLS certificates, supports bounded rotation overlap, central revocation, lost-Agent replacement, heartbeat evidence, and per-domain typed capability schemas. Studio gates every route and action through the canonical Fleet profile, static profile capability, project capability, RBAC, and binding isolation; Backup Operator requests in Fleet now resolve through the project management target instead of global URL/key configuration. Embedded behavior remains unchanged. Focused Go/API/UI tests and the T7 disposable Compose acceptance cover replay, wrong binding, expiry, revoked certificates, protocol mismatch, and two-target isolation. No ADR change was required; this implements ADR-003, ADR-009, ADR-010, ADR-011, and ADR-014. See [T7 management trust operations](./2026-07-15-t7-management-trust-operations.md).
- [x] **T8 (P2)** — Ownership-safe reconciliation — Implement observe-only/direct-managed/GitOps modes and Compose/Kubernetes field ownership guards.
  - Surfaced by: architecture review — rewriting user-owned deployment configuration would conflict with GitOps and external operators.
  - Files: Fleet Control providers, Stack Agent adapters, drift UI.
  - Verify: user-owned Compose/Kubernetes fields remain unchanged and conflicts return `ownership_conflict`.
  - Implemented: 2026-07-15 — added a versioned `runtime.config.reconcile` capability and typed desired/evidence schemas; a durable, fenced, reconnect-safe mTLS Agent task stream; and explicit observe-only, direct-managed, and GitOps ownership policies. The Compose adapter writes only project/binding/domain-marked generated revision directories and atomically switches a Fleet-owned symlink; the Kubernetes adapter uses allowlisted server-side apply fields with manager `supabase-fleet`, `force=false`, and preflight managed-field conflict detection. Foreign Compose content and fields owned by another Kubernetes manager remain unchanged and return `ownership_conflict` evidence with remediation. Platform schema 15 remains authoritative for project/domain ownership policy and CAS observation projection; Fleet Control schema 4 durably records tasks and typed evidence. Studio exposes the policy/drift UI only after Fleet profile, static capability, project capability, RBAC, active binding, and Agent capability checks; Embedded routes and UI remain unchanged. Focused Go/API/UI tests plus a disposable Compose acceptance cover mode behavior, conflict preservation, stale revision/generation rejection, audit, and two-project isolation. No ADR change was required; this implements ADR-003, ADR-004, ADR-009, ADR-010, ADR-011, ADR-013, and ADR-014. See [T8 ownership-safe reconciliation operations](./2026-07-15-t8-ownership-safe-reconciliation-operations.md).
- [ ] **T9 (P2)** — Edge Functions Fleet deployment — Implement project-isolated immutable artifacts, atomic activation, rollout probes, and rollback/manual intervention.
  - Surfaced by: failure-mode review — a generic copied directory is not a safe multi-project deployment protocol.
  - Files: Studio functions APIs/data/UI, artifact backend, Agent Compose/Kubernetes plugins.
  - Verify: archive security tests, project isolation E2E, failed-probe rollback, and large Kubernetes artifact test.
- [ ] **T10 (P2)** — Capacity and operations — Add bounded concurrency, backoff, retention, load tests, SLOs, and independent control-plane DR drills.
  - Surfaced by: performance review — the prior plan had no scale envelope or reconnect/fan-out controls.
  - Files: Fleet/backup runtimes, probe/metrics workers, deployment config, alert/runbook docs.
  - Verify: the section 14.1 envelope and section 18.6 failure matrix pass.
- [ ] **T11 (P3)** — Lifecycle providers — Add upgrades, replica lifecycle, network controls, and optional branching only behind versioned provider capabilities.
  - Surfaced by: scope review — these features are valuable but do not block a truthful attach/configuration/backup Fleet release.
  - Files: provider packages, impact-plan APIs, lifecycle UI.
  - Verify: provider contract, impact, rollback/manual intervention, and target-version compatibility tests.

## 22. Definition of done for a management feature

A Fleet management feature is not complete until all items pass:

- [ ] Stable capability name and blocker model exist.
- [ ] Profile behavior is defined for cloud, Embedded, Fleet, and CLI.
- [ ] The feature identifies its authoritative store and treats other copies as projections.
- [ ] Project-scoped RBAC and isolation tests pass.
- [ ] Request and response boundaries are schema-validated.
- [ ] Unsupported state is explicit and cannot return false success.
- [ ] Desired and observed states are separated where runtime work exists.
- [ ] Long-running work is durable and idempotent.
- [ ] Secrets are encrypted, masked, and redacted.
- [ ] Fleet browser responses contain no database/control-plane connection material.
- [ ] Configuration ownership and external GitOps behavior are defined.
- [ ] Control state needed for recovery is outside the managed recovery domain.
- [ ] Audit and correlation context are emitted.
- [ ] Loading, error, empty, degraded, drifted, and success UI states exist.
- [ ] Embedded zero-break tests pass.
- [ ] Fleet unit, API, integration, and relevant E2E tests pass.
- [ ] User-facing text participates in the i18n workflow.
- [ ] Upgrade, rollback, and operational remediation are documented.
- [ ] Supported target component versions and protocol compatibility are documented and tested.
- [ ] Both release profiles build from the same commit.

## 23. Developer workflow

### 23.1 Start a feature

1. Identify the profile and capability.
2. Confirm whether the operation is direct data-plane access or privileged reconciliation.
3. Define unsupported/degraded behavior before implementing success behavior.
4. Add or update generated contracts for cross-process APIs.
5. Name the authoritative store, immutable cross-store request/projection, and migration owner.
6. Implement server authentication, non-secret lookup, authorization, then secret resolution.
7. Implement the correct Fleet Control, Backup Operator, Agent, or direct-provider behavior.
8. Implement UI through shared capability hooks.
9. Add localization and all required test layers.
10. Verify both profiles.

### 23.2 Minimum local verification

Use focused tests during development. Before merging shared Studio changes:

```bash
pnpm --filter studio exec vitest run <changed-test-files>
pnpm --filter studio exec tsc --noEmit -p tsconfig.json
pnpm build --filter=studio
```

For Backup Operator/Agent changes:

```bash
cd apps/backup-operator
make generate
make check-generated
make build
make test
go vet ./...
```

Run profile-specific Compose/E2E checks proportional to the risk.

## 24. Architecture decision log

| ADR     | Decision                                                       | Status   |
| ------- | -------------------------------------------------------------- | -------- |
| ADR-001 | One source branch, two build profiles                          | accepted |
| ADR-002 | Direct data plane plus Operator/Agent execution plane          | accepted |
| ADR-003 | Typed capability model instead of product-mode inference       | accepted |
| ADR-004 | Desired/observed reconciliation; no successful no-ops          | accepted |
| ADR-005 | Project-scoped Edge Function artifact management in Fleet      | accepted |
| ADR-006 | Independent Backup Operator control store for destructive work | accepted |
| ADR-007 | Typed operations and no arbitrary shell                        | accepted |
| ADR-008 | Upstream-safe regenerable i18n codemod                         | accepted |
| ADR-009 | Separate Fleet Control and Backup Operator bounded contexts    | accepted |
| ADR-010 | One authoritative store per mutable domain                     | accepted |
| ADR-011 | Production control state outside every managed recovery domain | accepted |
| ADR-012 | Server-side Fleet database credential boundary                 | accepted |
| ADR-013 | Ownership-aware direct, observe-only, and GitOps modes         | accepted |
| ADR-014 | Non-destructive detach as the default removal operation        | accepted |

Future reversals add a new ADR row and link the superseded decision.

## 25. Related implementation documents

- [Self-platform all-in-one Compose design](./2026-07-10-self-platform-compose-design.md)
- [Project registry and connection resolver design](./2026-07-02-F9-F16-M2-project-registry-design.md)
- [Connection configuration design](./2026-07-05-M6.1-connection-config-design.md)
- [Health probing design](./2026-07-05-M6.0-health-probing-design.md)
- [Logflare pipeline design](./2026-07-06-M6.2-logflare-pipeline-design.md)
- [Infrastructure metrics design](./2026-07-06-M6.3-infra-metrics-design.md)
- [Kubernetes metrics identity design](./2026-07-08-M6.4-D3-k8s-metrics-dialect-design.md)
- [Go Backup Operator architecture](./2026-07-12-go-backup-operator-architecture.md)
- [Studio i18n design](../superpowers/specs/2026-07-02-studio-i18n-zh-cn-design.md)
- [Studio i18n operating guide](../../apps/studio/scripts/i18n/README.md)
- [Backup Operator production runbook](../../apps/backup-operator/docs/production-runbook.md)
- [T5 state authority and migration operations](./2026-07-15-t5-state-authority-operations.md)
- [T6 honest attachment operations](./2026-07-15-t6-honest-attachment-operations.md)
- [T7 management trust operations](./2026-07-15-t7-management-trust-operations.md)

## GSTACK REVIEW REPORT

| Review        | Trigger               | Why                        | Runs | Status      | Findings                                       |
| ------------- | --------------------- | -------------------------- | ---- | ----------- | ---------------------------------------------- |
| CEO Review    | `/plan-ceo-review`    | Scope and strategy         | 0    | Not run     | Product direction came from prior discussion   |
| Codex Review  | `/codex review`       | Independent second opinion | 1    | Unavailable | Outside-voice command returned no response     |
| Eng Review    | `/plan-eng-review`    | Architecture and tests     | 1    | CLEAR       | 13 issues found and corrected; 0 critical gaps |
| Design Review | `/plan-design-review` | UI and UX gaps             | 0    | Not run     | Required before broad Fleet UI implementation  |
| DX Review     | `/plan-devex-review`  | Developer experience gaps  | 0    | Not run     | May run after implementation scaffolding       |

**CODEX:** The independent outside-voice command returned no response, so no unverified recommendation was incorporated.

**VERDICT:** ENG CLEARED — the architecture baseline is ready for delivery-task decomposition; run a design review before implementing the new onboarding, status, ownership, and recovery UX.

NO UNRESOLVED DECISIONS
