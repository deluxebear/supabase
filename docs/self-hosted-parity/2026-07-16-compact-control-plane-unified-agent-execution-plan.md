# Compact Control Plane and Unified Agent Execution Plan

Status: proposed  
Date: 2026-07-16  
Owners: Fleet platform, Fleet execution, Backup and Recovery  
Target milestone: T12  
Normative baseline: [Dual-profile Studio platform architecture](./2026-07-15-dual-profile-studio-platform-architecture.md)

## 1. Decision summary

Supabase Fleet will support two deployment shapes without changing its domain boundaries:

1. **Compact**, the default for development, evaluation, and small or medium self-hosted installations:
   - one `supabase-control-plane` process hosts Fleet Control and Backup Operator modules;
   - one `supabase-agent` process hosts Fleet and Backup execution plugins;
   - Fleet and Backup keep distinct API namespaces, assertion audiences, authorization policies, stores, migrations, queues, retention policies, metrics, and audit records;
   - the platform outbox dispatcher remains a separately credentialed process;
   - the platform, Fleet, and Backup stores remain outside every managed-stack recovery domain.
2. **Hardened**, retained for high availability, regulated environments, and independent failure domains:
   - Fleet Control and Backup Operator run as separate processes or deployments;
   - Fleet and Backup stores run on separate PostgreSQL clusters or managed database services;
   - the same release artifacts, API contracts, Agent plugins, and Studio behavior are used.

Compact merges packaging and runtime supervision. It does not merge bounded contexts or mutable authorities.

This plan proposes ADR-016, which refines but does not supersede ADR-006 or ADR-009:

- ADR-006 continues to require an independent Backup authority and store.
- ADR-009 continues to require separate Fleet and Backup bounded contexts.
- ADR-016 permits co-location of those contexts in one process and co-location of their target plugins in one Agent when isolation invariants are enforced.

## 2. Problem statement

The current production Compose topology requires separate Fleet Control, Backup Operator, Backup Operator TLS proxy, Fleet Agent, and Backup Agent processes in addition to their stores and the platform services. This is appropriate for hardened deployments but creates unnecessary operational work for the default self-hosted path:

- more images, containers, health checks, ports, certificates, and upgrade steps;
- duplicate Agent enrollment, reconnect, journaling, and lifecycle management;
- partial installations expose UI routes whose backing domain is unavailable;
- a user can reach the Backup page while the Fleet profile capability is disabled and receive an opaque `404 Not found`;
- local acceptance testing requires assembling a topology that is larger than the managed Supabase stack being tested.

The code already supports the intended consolidation direction:

- Fleet Control and Backup Operator are commands in the same Go module;
- neutral Agent transport, fencing, and event contracts already live under `internal/shared`;
- the architecture explicitly permits one Go distribution and a shared Agent connection service;
- Fleet and Backup already use separate OpenAPI and Protobuf namespaces.

## 3. Goals

1. Reduce the default execution-plane footprint to one control process and one Agent process.
2. Preserve all Fleet and Backup API compatibility and security boundaries.
3. Preserve independent Fleet and Backup data authorities and migration ledgers.
4. Make Compact and Hardened runtime-equivalent from Studio's perspective.
5. Let operators move between Compact and Hardened without changing API contracts or rewriting stored data.
6. Make unavailable domains explicit in capability projections and UI blocker messages.
7. Keep Embedded Studio behavior byte-for-byte equivalent to upstream self-hosted behavior except localization.
8. Keep every Fleet action behind Profile, static Capability, project Capability, RBAC, active binding, and project-isolation checks.

## 4. Non-goals

- Merging Fleet and Backup tables, migrations, retention policies, or audit streams.
- Moving any control store into the managed Supabase PostgreSQL cluster.
- Replacing the existing Fleet or Backup OpenAPI contracts.
- Creating a generic untyped Agent command or arbitrary shell execution API.
- Removing Hardened manifests or independent service images.
- Making backup, PITR, or restore available without an enrolled Agent and configured repository.
- Changing Cloud, CLI, or Embedded Studio behavior.
- Consolidating the platform identity/registry service with the execution plane.
- Running the platform outbox dispatcher with broad control-plane credentials.

## 5. Users and observable outcomes

### 5.1 Affected users

- self-hosted operators installing Fleet Studio;
- administrators enrolling and upgrading managed stacks;
- database operators configuring backup, PITR, restore, and drills;
- release engineers testing Compact and Hardened artifacts;
- automated deployment and disaster-recovery systems.

### 5.2 Completion signals

The work is complete when:

- Compact starts one `supabase-control-plane` service and one `supabase-agent` per active binding;
- Studio can execute both a Fleet read operation and a Backup policy read through the same management target;
- cross-domain assertions, project IDs, binding IDs, task payloads, and evidence are rejected;
- stopping or degrading one domain returns a structured domain-specific blocker without corrupting or disabling the other domain's store;
- Hardened still passes its existing acceptance, recovery, capacity, and release tests;
- a Compact deployment can be switched to Hardened by changing process topology and endpoints only, with no schema conversion;
- a disabled or unconfigured Backup domain is hidden or shown as explicitly unavailable, never as an unexplained 404.

## 6. Required invariants

| Boundary           | Compact requirement                                                                     | Hardened requirement                           |
| ------------------ | --------------------------------------------------------------------------------------- | ---------------------------------------------- |
| API                | Fleet `/platform/fleet/v1/...`; Backup `/v1/clusters/...`                               | Same                                           |
| Assertion audience | `fleet-control` and `backup-operator` remain distinct                                   | Same                                           |
| Authorization      | Domain-specific scopes and policies                                                     | Same                                           |
| Store              | Separate DSNs, users, schemas/databases, ledgers                                        | Separate PostgreSQL clusters preferred         |
| Migrations         | Independent ordered SHA-256 ledgers                                                     | Same                                           |
| Queues             | Independent admission, concurrency, retry, and retention                                | Same                                           |
| Agent protocol     | Neutral envelope plus typed domain payload/evidence                                     | Same                                           |
| Agent journal      | One file may host separate domain tables and locks                                      | Separate files also supported                  |
| Secrets            | Domain-scoped handles; Backup repository credentials are not exposed to Fleet plugins   | Same                                           |
| Metrics            | Separate prefixes, readiness, and SLOs                                                  | Same                                           |
| Failure handling   | Domain degradation is reported independently                                            | Process/deployment isolation adds availability |
| Project isolation  | Organization, project, target, binding, and execution target checked on every operation | Same                                           |

The following conditions must fail closed before side effects:

- unknown domain or protocol major version;
- assertion minted for the wrong audience;
- project, target, binding, node, or execution target mismatch;
- capability not advertised by the exact Agent plugin;
- stale desired revision, generation, plan, or fencing token;
- duplicate idempotency key with a different payload digest;
- Backup task presented to a Fleet plugin or Fleet task presented to a Backup plugin;
- missing repository credential reference or restore confirmation evidence;
- disabled domain or unavailable authoritative store.

## 7. Target architecture

```text
Browser
  |
Fleet Studio UI and BFF
  |
  +-- Fleet assertion aud=fleet-control -------------------------+
  +-- Backup assertion aud=backup-operator ------------------+   |
                                                          |   |
                 supabase-control-plane                   |   |
                 +----------------------------------------+---+
                 | Fleet module                            | |
                 | - Fleet API, enrollment, desired work  | |
                 | - Fleet store and artifact store       | |
                 |                                        | |
                 | Backup module                           | |
                 | - Backup API, scheduler, restore plans | |
                 | - Backup store and repository evidence | |
                 |                                        | |
                 | Shared transport supervisor             | |
                 +-------------------+--------------------+-+
                                     | outbound mTLS
                                     v
                              supabase-agent
                 +----------------------------------------+
                 | neutral session, identity, heartbeat   |
                 | Fleet plugin: config/functions/lifecycle|
                 | Backup plugin: backup/WAL/PITR/restore |
                 | domain journals, locks, evidence        |
                 +-------------------+--------------------+
                                     |
                              managed stack
```

### 7.1 Listener model

Compact exposes:

- one TLS control endpoint for Studio domain APIs;
- one TLS enrollment endpoint;
- one mTLS gRPC Agent endpoint;
- one internal metrics endpoint with domain labels and bounded cardinality.

The control router dispatches by an exact allowlist:

- `/platform/fleet/v1/*` to the Fleet module;
- `/v1/clusters/*` and `/v1/operations/*` to the Backup module;
- no catch-all proxying;
- no browser-supplied upstream URL or audience.

During the compatibility window, distinct Fleet and Backup listener ports remain supported. The shared-port router is the Compact default; Hardened continues to expose separate services.

### 7.2 Process supervision

`supabase-control-plane` initializes each domain independently:

1. validate common TLS and logging configuration;
2. open and migrate the Fleet store using only Fleet credentials;
3. open and migrate the Backup store using only Backup credentials;
4. register exact API routes and assertion validators;
5. start domain workers with independent contexts, concurrency limits, and error channels;
6. start the shared Agent session broker;
7. publish per-domain readiness and aggregate liveness;
8. drain new work, finish or checkpoint bounded work, and close stores on shutdown.

A Fleet store or migration failure must not mutate the Backup store. Compact may start in a degraded state with Backup ready and Fleet unavailable, or vice versa. Aggregate readiness is false when any configured required domain is unavailable; per-domain readiness identifies the blocker. A process crash affects both domains and is an accepted Compact availability tradeoff, not a data-authority relaxation.

### 7.3 Store model

Compact keeps two DSNs:

- `FLEET_CONTROL_STORE_DSN`;
- `BACKUP_OPERATOR_CONTROL_STORE_DSN`.

They may point to two databases on one external PostgreSQL server for small installations, but must use different users, databases, migration ledgers, backup policies, and restore procedures. A deployment using one PostgreSQL server does not meet the Hardened recovery-domain claim.

No migration moves existing rows between stores. Compact and Hardened run the same migration packages against the same schemas.

### 7.4 Unified Agent model

Introduce `supabase-agent` as the canonical node process. It owns:

- one enrollment identity and certificate lifecycle per active binding;
- one outbound mTLS session with bounded reconnect jitter;
- one neutral task envelope containing domain, protocol version, capability, project, target, binding, node, fencing token, idempotency key, payload digest, and typed payload bytes;
- a registry of domain plugins;
- separate domain journals, locks, worker pools, capability sets, and evidence validators;
- bounded progress streaming and terminal evidence.

Initial plugins:

- `supabase.fleet` for configuration reconciliation, Edge Functions, and lifecycle actions;
- `supabase.backup` for backup, WAL, PITR, restore, and drill actions.

The unified process must not turn Backup privileges into general Fleet privileges. Backup helpers that require elevated filesystem, PostgreSQL, container, or Kubernetes permissions run through an allowlisted helper boundary or restricted subprocess. Plugin registration does not grant capabilities; capabilities are derived from validated configuration and provider discovery.

### 7.5 Compatibility aliases

For at least one minor release:

- `fleet-control` and `backup-operator` remain buildable entrypoints;
- `fleet-agent` and `backup-agent` remain wrappers or aliases around domain-limited `supabase-agent` modes;
- existing environment variables remain accepted;
- conflicting legacy and canonical variables fail startup with a named error;
- existing API paths and generated clients remain unchanged;
- no stored operation is rewritten solely because the process topology changes.

## 8. Configuration contract

Add canonical variables without removing existing domain variables:

```text
SUPABASE_CONTROL_PLANE_MODE=compact|fleet-only|backup-only
SUPABASE_CONTROL_PLANE_LISTEN=:8443
SUPABASE_CONTROL_PLANE_METRICS_LISTEN=:9090
SUPABASE_CONTROL_PLANE_TLS_CERT=/run/secrets/control/tls.crt
SUPABASE_CONTROL_PLANE_TLS_KEY=/run/secrets/control/tls.key

SUPABASE_AGENT_ADDRESS=control-plane:8092
SUPABASE_AGENT_CERT=/run/secrets/agent/tls.crt
SUPABASE_AGENT_KEY=/run/secrets/agent/tls.key
SUPABASE_AGENT_CA=/run/secrets/agent/ca.crt
SUPABASE_AGENT_DOMAINS=fleet,backup
SUPABASE_AGENT_JOURNAL=/var/lib/supabase-agent/journal.db
SUPABASE_AGENT_LOCK=/var/lib/supabase-agent/agent.lock
```

Existing `FLEET_CONTROL_*`, `FLEET_AGENT_*`, and `BACKUP_OPERATOR_*` variables remain domain configuration. Canonical common variables own only shared listener, TLS, identity, and journal configuration.

Validation rules:

- `compact` requires both store DSNs and both assertion audiences;
- audiences must be non-empty and different;
- enabled domains must have exact provider configuration;
- shared and legacy listener values must not conflict;
- repository secrets remain references or mounted files, never environment values returned through status APIs;
- readiness must report missing values by domain without logging secret content.

## 9. Studio behavior

Studio must treat deployment shape as invisible. It discovers domain readiness and capabilities from the bound management target.

Required changes:

- keep Profile, static Capability, project Capability, RBAC, active binding, and isolation gates;
- project capabilities distinguish `management.agent.connect`, Fleet actions, `backup.read`, `backup.manage`, and destructive restore actions;
- Backup navigation is hidden when the Fleet profile cannot support Backup management;
- a configured but offline Backup domain displays a localized blocker and correlation ID;
- an unconfigured Backup domain displays setup guidance, not `Not found`;
- Compact and Hardened management targets use the same API client and audience rules;
- Embedded does not import, render, or route Fleet-only controls.

The existing Fleet `backupManagement: false` setting must not be flipped in isolation. It becomes true only in the same change that supplies management-target domain discovery, project capability projection, route tests, and unavailable-state UI.

## 10. Implementation work packages

### T12.0: ADR and compatibility contract

Deliverables:

- add ADR-016 to the architecture decision log;
- define Compact and Hardened support claims;
- freeze API paths, audiences, store ownership, migration ledgers, and Agent envelope fields;
- add a compatibility matrix for legacy binaries and environment variables;
- document the accepted Compact process-level failure tradeoff.

Primary files:

- `docs/self-hosted-parity/2026-07-15-dual-profile-studio-platform-architecture.md`
- this execution plan
- `apps/backup-operator/docs/production-runbook.md`
- `apps/backup-operator/docs/fleet-control-runbook.md`

Exit criteria:

- ADR review confirms no authority or backup evidence moves into the Fleet store;
- every later work package references the frozen contracts.

### T12.1: Extract domain runtimes without behavior change

Deliverables:

- extract Backup Operator command construction into `internal/backupcontrol` with a validated `Config` and `Run(context.Context, Config)` entrypoint;
- keep `internal/fleetcontrol.Run` behavior stable;
- create reusable domain readiness and shutdown interfaces under `internal/shared/controlruntime`;
- keep existing commands as thin configuration adapters;
- add unit tests proving old commands build equivalent domain configs.

Primary files:

- `apps/backup-operator/cmd/backup-operator/main.go`
- `apps/backup-operator/internal/app/`
- `apps/backup-operator/internal/backupcontrol/` (new)
- `apps/backup-operator/internal/fleetcontrol/run.go`
- `apps/backup-operator/internal/shared/controlruntime/` (new)

Exit criteria:

- existing Backup and Fleet unit/E2E tests pass unchanged;
- generated OpenAPI and Protobuf files have no diff;
- separate binaries remain releaseable.

### T12.2: Add the Compact control-plane binary

Deliverables:

- add `cmd/control-plane` and `internal/controlplane`;
- compose Fleet and Backup modules with independent stores and workers;
- add exact-path TLS routing and per-domain assertion validation;
- expose `/health/live`, `/health/ready`, `/health/domains/fleet`, and `/health/domains/backup`;
- expose one metrics endpoint while preserving metric namespaces;
- implement bounded graceful shutdown and domain degradation;
- retain `fleet-only` and `backup-only` modes for compatibility and diagnostics.

Primary files:

- `apps/backup-operator/cmd/control-plane/` (new)
- `apps/backup-operator/internal/controlplane/` (new)
- `apps/backup-operator/internal/security/`
- `apps/backup-operator/internal/observability/`
- `apps/backup-operator/Makefile`

Required tests:

- exact router allowlist and no catch-all;
- Fleet token rejected by Backup routes and reverse;
- one domain store unavailable while the other remains responsive;
- concurrent migrations retain separate ledgers;
- shutdown drains both domains within the configured deadline;
- metrics contain domain labels without project/cardinality leaks.

### T12.3: Add the unified Agent

Deliverables:

- add `cmd/supabase-agent` as the canonical binary;
- extend the neutral transport envelope with an explicit domain and version if not already represented;
- register Fleet and Backup plugins under separate packages;
- use one certificate/session/heartbeat per active binding;
- keep domain-specific capabilities, worker pools, journals, fencing, idempotency, and evidence validation;
- add legacy wrapper modes for `fleet-agent` and `backup-agent`;
- isolate elevated Backup helpers from Fleet plugin access.

Primary files:

- `apps/backup-operator/cmd/supabase-agent/` (new)
- `apps/backup-operator/cmd/fleet-agent/main.go`
- `apps/backup-operator/cmd/backup-operator/agent_mode.go`
- `apps/backup-operator/internal/agent/`
- `apps/backup-operator/internal/fleetagent/`
- `apps/backup-operator/internal/agentjournal/`
- `apps/backup-operator/internal/shared/agenttransport/`
- `apps/backup-operator/api/proto/supabase/agent/transport/v1/transport.proto`
- domain Protobuf packages under `api/proto/supabase/fleet` and `api/proto/supabase/backup`

Required tests:

- wrong domain, version, capability, project, target, binding, node, or fence is rejected before execution;
- duplicate identical tasks replay terminal evidence without re-execution;
- duplicate keys with different digests are rejected;
- Backup credentials cannot be resolved by Fleet tasks;
- Agent restart orphans running work safely and reconnects with bounded jitter;
- Fleet and Backup tasks can run concurrently within independent limits;
- a saturated Fleet pool does not starve WAL/Backup health work;
- legacy Agent modes advertise only their allowed domain.

### T12.4: Package Compact deployment artifacts

Deliverables:

- build one multi-architecture `supabase-control-plane` image containing canonical and legacy entrypoints;
- build one multi-architecture `supabase-agent` image;
- add Compact Compose, Helm, Kustomize, and systemd profiles;
- keep Hardened manifests and image targets;
- remove the Backup TLS sidecar from Compact by serving TLS in the control-plane process;
- keep separate Fleet and Backup DSNs, secrets, volumes, and readiness checks;
- keep the platform outbox dispatcher separate and least-privileged.

Primary files:

- `apps/backup-operator/Dockerfile` and/or a new `Dockerfile.control-plane`
- `apps/backup-operator/Dockerfile.fleet-control`
- `apps/backup-operator/scripts/build-release.sh`
- `apps/backup-operator/scripts/build-release-candidate.sh`
- `apps/backup-operator/scripts/verify-release-candidate.sh`
- `apps/backup-operator/deploy/compose.yaml`
- `apps/backup-operator/deploy/fleet-control/compose.yaml`
- `apps/backup-operator/deploy/helm/backup-operator/`
- `apps/backup-operator/deploy/kustomize/`
- `apps/backup-operator/deploy/systemd/`
- `docker/self-platform/docker-compose.control-plane.yml`
- `docker/self-platform/control-plane.env.example`

Compact Compose target services:

```text
platform-db
platform-migrate
platform-auth
studio
meta
supabase-control-plane
platform-outbox-dispatcher
fleet-control-db
backup-operator-db
supabase-agent (one per managed binding or test fixture)
```

The two control databases remain separate services in the reference Compact file to preserve recovery clarity. Operators may use one external PostgreSQL server with separate databases and users, but that topology is documented as non-Hardened.

### T12.5: Management-target discovery and Studio UX

Deliverables:

- allow Fleet and Backup domain URLs to resolve to the same Compact endpoint;
- keep distinct audiences, schema versions, and health observations;
- project capabilities are projected from the exact bound target and Agent plugins;
- enable Fleet `backupManagement` only with all route and UI gates in place;
- hide unsupported navigation and render structured unconfigured/offline/incompatible blockers;
- replace opaque Backup `404 Not found` with stable codes such as `DOMAIN_DISABLED`, `TARGET_UNBOUND`, `DOMAIN_OFFLINE`, and `CAPABILITY_UNAVAILABLE`;
- add localized remediation without changing Embedded UI.

Primary files:

- `apps/studio/lib/constants/deployment-profile.ts`
- `apps/studio/lib/api/self-platform/management-trust.ts`
- `apps/studio/lib/api/self-platform/backup-operator-client.ts`
- `apps/studio/pages/api/platform/database/[ref]/backup-operator/[...operatorPath].ts`
- `apps/studio/components/interfaces/Database/Backups/`
- `apps/studio/components/layouts/Navigation/`
- `apps/studio/lib/i18n/locales/zh-CN.json`
- platform management-target and capability migrations under `docker/volumes/platform/migrations/`

Required tests:

- Profile, static Capability, project Capability, RBAC, binding, target, and project isolation at every route;
- two organizations and two projects cannot cross-read Backup or Fleet state;
- Compact and Hardened endpoints return identical client contracts;
- disabled Backup navigation is absent and direct API access fails closed;
- configured but offline Backup shows remediation rather than 404;
- Embedded snapshots, routes, navigation, and upstream self-hosted tests are unchanged except Chinese localization.

### T12.6: Migration, rollout, and release gates

Deliverables:

- run Compact and Hardened topologies in CI;
- add a topology-switch acceptance test using the same stores;
- publish signed compatibility metadata for the control plane and Agent;
- document canary, rollback, store backup, and certificate procedures;
- retain legacy artifacts for the compatibility window;
- mark Compact default only after all gates pass.

Exit criteria:

- no data migration is required to switch topologies;
- API and generated contract checks are clean;
- destructive restore and isolated drill tests pass in both topologies;
- the three-store recovery drill passes;
- an unavailable Fleet domain does not corrupt Backup evidence and reverse;
- release candidate verifies checksums, SBOM/provenance, version compatibility, and migration ledgers.

## 11. Ordering and dependency graph

```text
T12.0 ADR/contracts
   |
   v
T12.1 runtime extraction
   |
   +-------------------+
   v                   v
T12.2 control binary  T12.3 unified Agent
   |                   |
   +---------+---------+
             v
       T12.4 packaging
             |
             v
       T12.5 Studio UX
             |
             v
       T12.6 rollout/release
```

T12.2 and T12.3 may proceed in parallel only after T12.0 freezes the envelope, audience, and readiness contracts. T12.5 must not enable Backup capability before the Compact endpoint and Agent plugin pass acceptance tests.

## 12. Test matrix

### 12.1 Go and generated contracts

```bash
cd apps/backup-operator
make generate
make check-generated
make build
make test
go vet ./...
```

Add targeted race and fuzz coverage where practical:

```bash
go test -race ./internal/controlplane ./internal/shared/... ./internal/agent/... ./internal/fleetcontrol/...
go test -fuzz=Fuzz -run='^$' ./internal/shared/agenttransport
```

### 12.2 Studio

```bash
pnpm test:studio
pnpm typecheck
pnpm lint --filter=studio
pnpm build --filter=studio
```

Focused suites must include Backup proxy, management trust, navigation capability, localized blockers, and Embedded isolation tests.

### 12.3 Deployment validation

```bash
cd apps/backup-operator
make validate-deployments
./scripts/verify-release-candidate.sh
```

Add:

- `test/e2e/compact-control-plane.sh`;
- `test/e2e/compact-unified-agent.sh`;
- `test/e2e/compact-to-hardened-switch.sh`;
- a disposable Compose fixture with two projects and two management targets;
- Kubernetes smoke coverage for the unified Agent ServiceAccount and plugin capability projection;
- systemd install/upgrade/rollback coverage for one Agent unit.

### 12.4 Failure injection

The acceptance suite must prove:

- Fleet store unavailable, Backup policy/readiness still works;
- Backup store unavailable, Fleet read-only and permitted operations still work;
- wrong audience and cross-project assertions return 401/403 without downstream calls;
- corrupted or changed migration files fail the affected domain readiness;
- Agent loses connection mid-task and resumes or reports manual intervention deterministically;
- Fleet queue saturation does not block Backup health/WAL duties;
- Backup repository outage does not allow a restore plan to execute;
- process restart preserves journal, locks, idempotency, and terminal evidence;
- Compact-to-Hardened rollback uses the same stores and accepts existing operations.

## 13. Rollout plan

1. Ship runtime extraction with no topology change.
2. Publish the Compact binaries behind an experimental release flag.
3. Run dual-topology CI and disposable acceptance tests.
4. Canary Compact on a non-production managed stack with backup repository and restore drill.
5. Enable Compact installation docs while keeping Hardened recommended for HA/compliance.
6. Enable Studio Backup capability only for targets advertising compatible Backup API and Agent protocol versions.
7. Make Compact the default for new small/medium self-hosted installations after one release of compatibility evidence.
8. Keep legacy binaries and Hardened manifests for at least one minor release after Compact becomes default.

No automatic conversion of an existing deployment is allowed. Operators select the topology explicitly during upgrade.

## 14. Rollback plan

Rollback is topology-only:

1. stop admission of new Compact operations;
2. wait for bounded running work or mark uncertain work `manual-intervention`;
3. stop `supabase-control-plane` and `supabase-agent`;
4. start legacy `fleet-control` and `backup-operator` processes against their unchanged DSNs;
5. start domain-limited Agent wrappers against the existing enrollment identity or perform the documented certificate transition;
6. verify both migration ledgers, domain readiness, active bindings, Backup repository health, and terminal operation evidence;
7. re-enable Studio mutations.

Rollback must not restore, copy, or merge control databases. If a Compact deployment used one external PostgreSQL server, rollback may still run two processes against its two separate databases.

## 15. Security review checklist

- [ ] Two assertion audiences and validators remain mandatory.
- [ ] Domain routes use exact path allowlists.
- [ ] Browser authorization is never forwarded to the Agent.
- [ ] Every Fleet/Backup route enforces Profile, Capability, RBAC, and project isolation.
- [ ] Agent identity binds organization/project/target/binding/node.
- [ ] Domain and protocol versions are signed or covered by the task digest.
- [ ] Backup repository and restore credentials are unavailable to Fleet plugins.
- [ ] AAL2 and exact confirmation remain mandatory for destructive restore actions.
- [ ] No arbitrary command or shell payload exists.
- [ ] Store users cannot read or mutate the other domain's tables.
- [ ] Logs, metrics, errors, and evidence redact secrets.
- [ ] Compact process and Agent run non-root except narrowly scoped helpers.
- [ ] Docker/Kubernetes/systemd permissions remain allowlisted by provider.
- [ ] SBOM, provenance, image signature, and compatibility manifest cover all entrypoints.

## 16. Operational documentation

Update runbooks with:

- choosing Compact versus Hardened;
- sizing and concurrency defaults;
- shared endpoint and distinct audience configuration;
- per-domain readiness and alert interpretation;
- store backup and independent recovery procedures;
- Agent plugin capability discovery;
- repository credential rotation;
- topology switch and rollback;
- process-crash availability tradeoffs in Compact;
- criteria requiring migration to Hardened.

Move to Hardened when any of the following applies:

- independent Fleet and Backup availability is required;
- regulated separation of duties requires distinct runtime identities;
- Backup evidence has a stricter recovery objective than Fleet operations;
- one domain's load can exhaust the shared process despite configured limits;
- control databases require independent patch, failover, or maintenance windows;
- the deployment needs independent horizontal scaling.

## 17. Definition of Done

- [ ] ADR-016 is accepted and linked from the architecture document.
- [ ] Compact and Hardened topology contracts are documented.
- [ ] `supabase-control-plane` and `supabase-agent` build for amd64 and arm64.
- [ ] Legacy commands remain compatible for the declared window.
- [ ] Fleet and Backup APIs, audiences, stores, migrations, queues, retention, and evidence remain separate.
- [ ] Compact uses one control process and one Agent process.
- [ ] Hardened manifests remain supported and tested.
- [ ] Studio exposes no unsupported Backup page or opaque 404.
- [ ] All Fleet routes pass Profile, Capability, RBAC, binding, and project-isolation tests.
- [ ] Embedded behavior remains upstream-compatible except localization.
- [ ] Unit, race, generated-contract, typecheck, lint, build, Compose, Kubernetes, systemd, recovery, capacity, and E2E gates pass.
- [ ] Compact-to-Hardened and Hardened-to-Compact topology-switch tests pass without data conversion.
- [ ] Failure injection proves domain data integrity and independent readiness.
- [ ] Release artifacts include checksums, signatures, SBOM/provenance, and a compatibility manifest.
- [ ] Upgrade, rollback, DR, and security runbooks are updated.

## 18. Explicit review questions

The architecture review must answer these before implementation begins:

1. Is Compact the default for all non-HA production installations, or only development/evaluation in the first release?
2. Is one external PostgreSQL server with two databases an officially supported Compact production topology or a documented best-effort option?
3. Does the shared Agent broker terminate one neutral mTLS stream, or temporarily maintain two domain streams inside one process during migration?
4. Which Backup helpers require a separate restricted subprocess or system service?
5. What compatibility window applies to legacy binaries and environment variables?
6. What exact SLO or compliance criteria force Hardened mode?

Implementation must not silently decide or relax these items. Accepted answers belong in ADR-016 and the compatibility manifest.
