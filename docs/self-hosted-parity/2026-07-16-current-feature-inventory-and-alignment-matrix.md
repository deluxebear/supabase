# Current customization inventory and product alignment matrix

- Date: 2026-07-16
- Branch: `custom/main`
- Scope: upstream self-hosted Studio, Supabase Cloud Studio, and Fleet multi-instance Studio
- Status: current implementation inventory and release acceptance baseline

## 1. How to read this matrix

The three columns describe product contracts, not visual similarity:

- **Upstream** means official Embedded/CLI self-hosted Studio behavior.
- **Cloud** means the hosted Studio contract. Commercial control-plane internals are not assumed to be reusable.
- **Fleet** means this fork's independent multi-instance product.

Status terms are fixed:

- **Aligned**: the user outcome and safety contract are implemented.
- **Equivalent**: Fleet implements the outcome through a different self-hosted provider.
- **Direct**: Studio calls the attached stack's data plane after project RBAC.
- **Gated**: available only after a versioned project/Agent/provider capability is observed.
- **Honest degradation**: visible state explains why an action is unavailable; no false success or opaque 404.
- **Hidden**: the product does not implement the contract and does not advertise it.
- **Optional**: not part of the Fleet release gate.

## 2. Product alignment matrix

| Capability                                                        | Upstream self-hosted              | Cloud                                | Fleet multi-instance                         | Current evidence / boundary                                                                                                               |
| ----------------------------------------------------------------- | --------------------------------- | ------------------------------------ | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Upstream Studio UI and security fixes                             | Source baseline                   | Source baseline plus hosted services | Aligned from the same commit                 | One `custom/main`; separate build-time profiles in `deployment-profile.ts`                                                                |
| Simplified Chinese                                                | Fork extension                    | Fork extension when built here       | Aligned                                      | English source keys plus `public/locales/zh-CN.json`; sync/check scripts and tests                                                        |
| Single embedded stack                                             | Aligned                           | Not applicable                       | Not the Fleet topology                       | Embedded/CLI retain upstream environment and mounted-volume behavior                                                                      |
| Multiple organizations and projects                               | Not provided by Embedded          | Aligned                              | Aligned                                      | Platform GoTrue, profiles, organizations, memberships, invitations, project registry                                                      |
| MFA and recent AAL2                                               | Upstream Auth user feature        | Aligned                              | Aligned for destructive management actions   | Platform identity plus AAL2 confirmation contracts                                                                                        |
| Project-scoped RBAC                                               | Single-stack boundary             | Aligned                              | Aligned                                      | Organization/project guards run before credential resolution; Owner/Developer/Read-only roles                                             |
| Attach an existing stack                                          | Manual environment wiring         | Cloud provisions projects            | Aligned                                      | Multi-service preflight, stable stack fingerprint, duplicate protection, candidate revision, detach                                       |
| Secret handling                                                   | Server environment                | Hosted secret plane                  | Aligned                                      | Encrypted registry values, server-side resolution, browser response redaction, no caller-supplied DSN                                     |
| Database browser and SQL editor                                   | Direct                            | Direct                               | Direct                                       | Per-ref server-side pg-meta proxy and read-only role threading                                                                            |
| Auth users and configuration                                      | Direct for users; env for runtime | Direct plus hosted runtime controls  | Direct users; runtime controls gated         | Desired/observed revisions and Fleet reconciliation for runtime-owned fields                                                              |
| Storage buckets and objects                                       | Direct                            | Direct                               | Direct                                       | Project service key is resolved server-side after RBAC                                                                                    |
| REST and GraphQL exploration                                      | Direct                            | Direct                               | Direct                                       | Per-project gateway and REST endpoints                                                                                                    |
| Realtime inspection                                               | Direct                            | Direct                               | Direct                                       | Per-project service endpoint; runtime changes require reconciliation capability                                                           |
| Logs                                                              | Optional Logflare                 | Aligned                              | Equivalent when endpoint is configured       | Per-project endpoint/token; unavailable state remains explicit                                                                            |
| Infrastructure and workload metrics                               | Deployment-specific               | Aligned                              | Equivalent                                   | Per-project Prometheus target plus Compose container or Kubernetes workload identity                                                      |
| Stack health                                                      | Limited self-hosted page state    | Aligned                              | Aligned with stronger dimensions             | Database, service, management, drift, and operation dimensions are independent and timestamped                                            |
| Edge Functions from mounted directory                             | Aligned                           | Remote deployment                    | Embedded aligned; Fleet equivalent and gated | Immutable project bundles, Fleet Control/Agent deployment, atomic activation and rollback                                                 |
| Runtime configuration rollout                                     | Environment/manual restart        | Hosted rollout                       | Equivalent and gated                         | Observe-only, direct-managed, and GitOps ownership policies; no successful no-op mutation                                                 |
| Lifecycle: restart, rollout, scale, upgrade, replica, network ban | Operator/manual                   | Hosted provider                      | Equivalent and gated                         | Strict version matrix, installed provider plugin, impact plan, AAL2, journal, verification and rollback evidence                          |
| Branching                                                         | Not provided                      | Hosted feature                       | Optional and gated                           | Hidden unless an exact provider capability is installed and compatible                                                                    |
| Logical/physical backups                                          | Operator/manual                   | Hosted backups and PITR              | Equivalent through Backup Operator           | Policy, jobs, recovery window, drills, restore plan, confirmation, rollback/manual-intervention evidence                                  |
| Backup route when no Operator/Agent is enrolled                   | Not advertised                    | Available                            | Honest degradation                           | Fleet navigation is capability-based; status returns correlated unconfigured/offline/incompatible/unauthorized remediation instead of 404 |
| Billing, invoices and spend                                       | Not provided                      | Aligned                              | Hidden                                       | Commercial Cloud capability; intentionally outside Fleet scope                                                                            |
| Cloud compute purchase and regions                                | Not provided                      | Aligned                              | Hidden                                       | Fleet attaches or manages user-owned infrastructure; it does not sell compute                                                             |
| Supabase-operated support and SLAs                                | Not provided                      | Aligned                              | Hidden                                       | Operational ownership remains with the Fleet operator                                                                                     |

## 3. Implemented customization inventory

### Product and release foundations

- Typed `cloud`, `embedded`, `fleet`, and `cli` deployment profiles with legacy flag validation.
- Separate Embedded and Fleet image builds from one source commit.
- Upstream-safe localization runtime, Simplified Chinese catalog, extraction, validation, and synchronization workflow.
- Checksum-locked platform and Fleet Control schema migrations with locking and readiness gates.
- Production recovery-domain separation for platform identity/registry, Fleet Control, and Backup Operator stores.

### Identity, registry, and data-plane access

- Platform authentication, profile bootstrap, organizations, memberships, roles, invitations, and MFA context.
- Project registry with encrypted credentials, TLS/key modes, candidate connection revisions, 24-hour rollback revision, and non-destructive detach.
- Stack identity proof, required service preflight, duplicate attachment protection, and staged activation.
- Project-scoped pg-meta, Auth, Storage, REST, GraphQL, logs, and metrics adapters.
- Real health probes, cached observations, write-through status, container identity, and Kubernetes workload identity.

### Management-plane capabilities

- Independent Fleet Control and Backup Operator bounded contexts, stores, API namespaces, assertions, and Agent protocols.
- Organization management targets, one active binding per project, single-use enrollment, CSR/mTLS issuance, rotation, revocation, replacement, and compatibility negotiation.
- Platform-owned desired state, transactional outbox, leased dispatcher, immutable snapshots, and revision/generation CAS observations.
- Ownership-safe Compose and Kubernetes reconciliation for direct-managed and GitOps modes.
- Immutable Edge Function artifacts, project isolation, atomic rollout, invocation probes, rollback, and manual-intervention state.
- Capacity limits, reconnect jitter, bounded fan-out/concurrency, retention/compaction, low-cardinality metrics, SLOs, and control-plane DR drills.
- Versioned lifecycle provider plans and evidence for restart/rollout/scale, PostgreSQL upgrade, replicas, network controls, and optional branching.
- Backup discovery, policy, full/differential/incremental jobs, WAL/PITR observation, isolated restore drills, destructive restore planning, fencing, AAL2 confirmation, durable events, rollback, and manual recovery.

## 4. Closed gaps in this stabilization pass

| Gap                                                                                                          | Closure                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fleet Backup navigation was disabled even though the Operator path existed                                   | `backupManagement` is a Fleet profile capability and Database navigation uses that capability rather than the broad Cloud platform flag               |
| A visible/direct Backup route could end in an opaque 404                                                     | The status endpoint resolves project management binding and Backup domain availability, probes readiness, and returns a typed correlated state        |
| Backup/PITR components launched resource queries before knowing the management domain was usable             | Both pages gate resource queries behind the status contract and render explicit loading, error, setup, offline, incompatible, and unauthorized states |
| Backup writes used a generic update permission                                                               | Writes require infrastructure execution; destructive restore planning uses the dedicated restore-prepare resource                                     |
| Service assertions always received read/write/restore scopes                                                 | Scopes are minimized by method and path: `backup.read`, `backup.write`, or `restore.execute`                                                          |
| Fleet static capabilities still described implemented runtime/lifecycle/backup paths as unavailable          | Static profile capabilities now advertise the implemented surface; runtime project/provider capability checks remain fail-closed                      |
| The ownership reconciliation acceptance treated a legitimate seeded function policy as cross-project leakage | The assertion now checks the ownership/domain fields that define leakage while preserving the migration-seeded policy                                 |
| Platform migration acceptance hard-coded 18 migrations after T11 added migration 19                          | The acceptance derives the expected count from the controlled migration directory and continues to verify lock, replay, and checksum behavior         |
| Local Docker builds transferred multi-gigabyte tool output and caches                                        | `.dockerignore` excludes `.turbo`, coverage, dist, and TypeScript build artifacts                                                                     |

## 5. Release gates and remaining honest boundaries

Fleet is releasable only when all of these are true:

1. The focused Studio, Go, profile, i18n, RBAC, and management-domain tests pass.
2. `verify-platform-state-authority.sh` proves fresh/legacy/concurrent migrations and checksum tamper rejection.
3. The T6-T11 disposable Compose acceptances pass for attachment, trust, reconciliation, Edge Functions, capacity/DR, and lifecycle providers.
4. `verify-multi-instance-e2e.sh` passes against two real Docker-backed Supabase stacks, including preflight evidence, distinct PostgreSQL identities, health, Backup honest degradation, secret redaction, and non-destructive detach.
5. A configured production release separately proves Backup Operator readiness and a successful backup/restore drill. The local two-stack acceptance does not fabricate this evidence.

The following remain explicit product boundaries, not bugs:

- Billing, Cloud compute purchasing, managed regions, and Supabase-operated infrastructure stay hidden.
- Branching remains optional and unavailable without a compatible provider plugin.
- An unenrolled or offline management target does not allow runtime, lifecycle, Edge Function deployment, or Backup actions.
- A successful schema migration is not rolled back by applying older SQL. Recovery uses forward fixes or a coordinated, rehearsed store restore.
- Destructive target operations can end in `manual-intervention` when postconditions or rollback cannot be proved.

## 6. Control Plane and Agent decision

Do **not** merge Fleet Control and Backup Operator semantics, stores, API namespaces, or recovery state machines. The bounded contexts are now implemented and independently recoverable.

Do **not** require a compact unified process for functional completeness. The current Fleet feature surface can be stabilized and accepted without it.

Reconsider a compact Control Plane image and a unified Agent process only after stable-release measurements show a material operational problem, such as excessive deployment objects, duplicated certificate rotation incidents, unacceptable idle memory, or upgrade skew. Even then, consolidation may share packaging and transport libraries only; authorization, schemas, stores, assertions, capability prefixes, and failure domains remain separate. The T12 plan is therefore a deferred packaging optimization, not the next feature milestone.
