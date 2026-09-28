# Fleet completion roadmap

- Date: 2026-09-28
- Branch: `custom/main`
- Status: plan; supersedes nothing. Normative rules still come from the [dual-profile architecture baseline](./2026-07-15-dual-profile-studio-platform-architecture.md).
- Inputs: the [alignment matrix](./2026-07-16-current-feature-inventory-and-alignment-matrix.md), the [2026-07-18 QA report](./2026-07-18-fleet-studio-cloud-parity-qa-report.md), and a code-level audit of `apps/backup-operator`, `apps/studio/lib/api/self-platform`, and `docker/fleet-managed` on 2026-09-28.

## 1. Where Fleet actually stands

The control-plane pipeline (Studio BFF → `platform.operation_outbox` → dispatcher → Fleet Control → mTLS Agent → typed provider → evidence) is complete and well tested. `go test ./...` passes for all 39 packages. The Studio self-platform suites pass except one stale assertion.

What reaches a managed stack and has an effect today:

| Capability                                                                        | Code path                                                                                                                                                     | State                                                  |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Identity, orgs, RBAC, MFA, invitations                                            | `lib/api/self-platform/*`, migrations 01–06                                                                                                                   | Works                                                  |
| Attach, preflight, rollback, detach                                               | migrations 13, 21–23, 32                                                                                                                                      | Works; P0 wizard fix (`f5f75a2`) not re-verified by QA |
| Data plane (SQL, tables, Auth users, Storage, REST, Realtime)                     | per-ref BFF proxies                                                                                                                                           | Works                                                  |
| Edge Function deploy                                                              | `fleetfunctions/compose.go` writes into the bind mount that `functions` serves (`docker/fleet-managed/docker-compose.override.yml:69-80`), probes, rolls back | **Works end to end**                                   |
| Database security (pooler SSL, CIDR allowlist, pool size, role password rotation) | `fleetdatabase/postgres_runtime.go` updates `_supavisor.tenants`, `ALTER ROLE`, then syncs the registry                                                       | **Works** (Compose and Kubernetes)                     |
| Runtime inventory                                                                 | `fleet-compose-observer` (Docker API reads) + PostgreSQL queries                                                                                              | Works (read-only)                                      |

What looks present but has no effect:

| Capability                                                             | Gap                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth configuration page                                                | Saves to `platform.auth_config` only. GoTrue reads env at boot and nothing applies the stored config. The UI reports success for a change that never happens, which violates A7.                                                                                                                                           |
| Runtime config reconciliation                                          | `fleetproviders/compose.go` writes files under `FLEET_CONFIG_ROOT` and swaps a `current` symlink. No service mounts that root and nothing restarts. No Studio feature produces a `runtime.config.reconcile` desired document; drift checks only replay existing ones. `capabilities.json` still advertises the capability. |
| Lifecycle (restart, rollout, scale, replicas, network bans, branching) | Only the plugin protocol exists (`fleetlifecycle/plugin_runtime.go`). No plugin ships and `docker/fleet-managed` does not configure one.                                                                                                                                                                                   |
| PostgreSQL major upgrade                                               | Inventory always emits the `provider_not_registered` blocker (`fleetinventory/provider.go:183`).                                                                                                                                                                                                                           |
| Backup and PITR on Fleet Compose stacks                                | The Backup Operator engine is complete, but `docker/fleet-managed` has no backup agent, archive configuration, or repository. Pages correctly show the offline state.                                                                                                                                                      |
| Logs and metrics                                                       | Proxies exist; endpoints are not provisioned per project, so the QA run saw 404 and 500 responses.                                                                                                                                                                                                                         |

Hygiene findings from the same audit:

- `lib/api/self-platform/projects.test.ts` fails. The fixture predates the public endpoint registry (`666630e`), so `db_host` and `restUrl` now resolve to empty strings.
- `fleet-compose-observer` mounts `/var/run/docker.sock:ro`. A read-only bind of the socket does not restrict the Docker API, so the observer effectively holds host root.
- Migration prefixes `05` and `26` are each used twice.
- `fleet-control` and `fleet-agent` images (`Dockerfile.fleet-control`) have no release workflow. Only `:simulation` images built locally exist.
- `data/reports/database-report-query.ts:12` falls back to `projectRef ?? 'default'` without the `IS_PLATFORM` guard used by the sibling report queries. It is a candidate cause of the "wrong ref" observability requests in the QA report.

## 2. Principles for this roadmap

1. **Honesty before capability.** Remove false success first, then add real behavior behind the same contract.
2. **Reuse the existing pipeline.** Every new write goes through desired state, the outbox, Fleet Control, the Agent journal, and evidence. No side channels.
3. **Plaintext secrets never enter the outbox.** `platform.operation_outbox.snapshot_canonical` is plaintext text. Secrets travel through an encrypted write-only channel, following the `platform.function_secrets` pattern from migration 28.
4. **The Agent gets no generic Docker access.** Container operations run in a separate plugin behind an allowlisting socket proxy, scoped to one Compose project.
5. **Every phase ends with evidence.** Unit and acceptance tests, the 91-route crawl, and an update to the alignment matrix.

## 3. Phases

Rough sizes assume one developer. Phases 0 → 1 → 2 are sequential. Phases 3, 4, and 5 can run in parallel with 1 and 2.

### Phase 0: honesty and hygiene (about 1 week)

| ID  | Work                                                                                                                                                                                                                                                          | Main files                                                                            | Done when                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 0.1 | In the Fleet profile, show the Auth runtime settings as **saved, not applied**. Label the desired revision, show that no observed revision exists, and link to the Phase 2 path. Keep the user-management features that go directly to the project unchanged. | `pages/api/platform/auth/[ref]/config.ts`, Auth settings components, `auth-config.ts` | No Fleet Auth settings save shows an unqualified success toast; component test covers the state |
| 0.2 | Stop advertising `runtime.config.reconcile` until a consumer exists (Phase 2). Keep the ownership-policy page gated on it.                                                                                                                                    | `docker/fleet-managed/capabilities.json`                                              | Ownership-policy UI shows honest unavailability                                                 |
| 0.3 | Fix the stale `projects.test.ts` fixture by giving it an `endpoint_document`, and add a case for the legacy internal hostname returning an empty string                                                                                                       | `lib/api/self-platform/projects.test.ts`                                              | Self-platform suite is green                                                                    |
| 0.4 | Put a GET-only Docker API proxy in front of `fleet-compose-observer`, limited to `/containers/json`, `/containers/{id}/json`, `/volumes`, `/system/df`, filtered by the Compose project label                                                                 | `docker/fleet-managed/docker-compose.override.yml`, new proxy config                  | Observer has no socket mount; a `POST` through the proxy returns 403                            |
| 0.5 | Add a CI guard that rejects new duplicate migration prefixes. Leave the existing `05` and `26` duplicates as they are, because the checksum runner has already recorded them.                                                                                 | `docker/self-platform/scripts/run-platform-migrations.sh` or a CI step                | CI fails on a new duplicate prefix                                                              |
| 0.6 | Add a release workflow for `Dockerfile.fleet-control` modeled on `backup-operator-release.yml` (multi-arch, OCI labels, cosign)                                                                                                                               | `.github/workflows/fleet-control-release.yml`                                         | Tagged `fleet-control/v*` publishes a signed image; env examples reference it                   |
| 0.7 | Re-run the QA crawl. Verify the attach wizard fix, enforce the canonical Studio origin (redirect non-canonical hosts), and fix the `'default'` ref fallback                                                                                                   | `data/reports/*`, Kong or Studio origin config                                        | Crawl has no hard FAIL; attach wizard passes                                                    |

Phase 0 status (2026-09-28):

| ID  | Status                                                                                                                                                                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0.1 | Done: `appliedAuthConfiguration` capability, Auth configuration notice in `AuthLayout`, deduplicated info toast in the shared mutation                                                                                                     |
| 0.2 | Done: removed from `capabilities.json`, and `fleet-agent` only advertises it behind `--advertise-config-reconcile`. The Agent hello replaces enrollment capabilities, so the file change alone was not enough.                             |
| 0.3 | Done                                                                                                                                                                                                                                       |
| 0.4 | Done: `fleet-docker-proxy` (`internal/dockerproxy`) enforces GET-only rules, forces the project label filter, and rejects other projects' containers. Covered by Go tests against a fake Docker Engine. Not yet run against a live daemon. |
| 0.5 | Done: `check-platform-migration-names.sh`, run by the migration runner and the `Platform Migrations Check` workflow                                                                                                                        |
| 0.6 | Done: `fleet-control-release.yml`                                                                                                                                                                                                          |
| 0.7 | Partly done: the `'default'` ref request was fixed upstream (`eb738d2b`) and arrived with the 2026-09-26 sync. The canonical-origin redirect and the 91-route crawl need a live environment.                                               |

### Phase 1: Compose lifecycle reference plugin (2–3 weeks)

Goal: make `runtime.restart` and `runtime.rollout` real for Compose targets. Phase 2 depends on this.

Design:

- New binary `cmd/fleet-lifecycle-compose` that implements `supabase.fleet.lifecycle.plugin.v1` (observe, apply, verify, rollback) for `runtime.restart` and `runtime.rollout`.
- **Restart does not reload `env_file`.** A restarted container keeps its original environment, so configuration changes need a recreate. `runtime.rollout` therefore runs `docker compose up -d --no-deps --force-recreate <service>` through `exec.Command` with fixed arguments and no shell, against the managed project's Compose files mounted read-only into the plugin container.
- Docker access goes through a second socket proxy that allows only the container create, start, stop, restart, and inspect calls Compose needs, filtered to the managed project label. Allowed services come from an explicit list (`auth`, `rest`, `realtime`, `storage`, `functions`, `meta`, `supavisor`). `db` stays excluded from rollout until the Phase 3 write fence covers it.
- Verify: the container is healthy (healthcheck) and a service probe passes (for example GoTrue `/health` or PostgREST `/`). Rollback for rollout: recreate with the previous Compose revision. If verify still fails, report `manual-intervention`.
- Wiring: set `FLEET_AGENT_LIFECYCLE_PLUGIN`, `FLEET_AGENT_LIFECYCLE_CAPABILITIES=runtime.restart,runtime.rollout`, and `FLEET_AGENT_LIFECYCLE_COMPONENT_VERSIONS` (generated by `init-instance-env.sh` from the pinned images). Add both capabilities to `capabilities.json`.
- Studio: `SelfPlatformLifecyclePanel` already renders plans and operations. Confirm that it enables restart and rollout for the allowed services.

Done when:

- Go unit tests cover the plugin protocol, the allowlist, and rollback.
- A new `verify-compose-lifecycle.sh` restarts `auth` and rolls out `rest` on a disposable stack. It also covers an injected healthcheck failure, which must end in `rolled-back`, and an injected rollback failure, which must end in `manual-intervention`.
- The Infrastructure page shows lifecycle as available on an enrolled project.

Phase 1 status (2026-09-28): implemented, pending live acceptance.

| Piece                                                   | State                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fleet-lifecycle-compose` (`internal/composelifecycle`) | Done. Restart uses the Docker API; rollout runs the Compose CLI with fixed arguments and a minimal environment. Rollback for rollout converges without `--force-recreate` and reports success only when the service is healthy. End-to-end tests drive the Agent's `ManagedProvider` and `PluginRuntime` against the compiled plugin, a fake Docker API, and a fake Compose CLI (success, apply failure, verification failure, persistent Compose failure). |
| `fleet-docker-proxy` lifecycle policy                   | Done. Writes require an allowlisted service of this project; container create bodies are checked for labels, privileges, host namespaces, devices, networks, volumes, and bind prefixes; image pulls and network or volume creation are refused; removals keep volumes.                                                                                                                                                                                     |
| Image                                                   | `Dockerfile.fleet-control` adds the plugin and the Compose CLI from `docker/compose-bin` (`COMPOSE_VERSION`). The release workflow smoke-tests both before publishing.                                                                                                                                                                                                                                                                                      |
| Wiring                                                  | Opt-in overlay `docker/fleet-managed/docker-compose.lifecycle.yml`, so existing instance env files keep working. `init-instance-env.sh` writes the overlay variables for new instances.                                                                                                                                                                                                                                                                     |
| Acceptance                                              | `docker/self-platform/scripts/verify-compose-lifecycle.sh` (restart, rollout with env change, unhealthy rollout and rollback, proxy boundaries). Not yet run: it needs a Docker host. If Compose reports a 403 from the proxy, add the missing read to `LifecycleRules` with a test.                                                                                                                                                                        |

Follow-up: component versions are static JSON that must match between Studio and every Agent. Replacing them with versions derived from `runtime.observe` evidence would remove that manual step.

### Phase 2: real runtime configuration, Auth first (about 3 weeks)

Goal: a saved Auth setting becomes an observed, applied revision.

Flow:

1. Studio saves Auth config. In the same platform transaction, it renders the GoTrue env subset for non-secret fields into a Compose document (`auth/auth.env`) and calls `commitDesiredConfiguration` with domain `fleet.runtime.auth` and capability `runtime.config.reconcile`.
2. Secret fields (`SECRET_FIELDS`: OAuth secrets, `SMTP_PASS`) do not go into the document. They go into a new encrypted `platform.runtime_secrets` table (migration 33, same model as `function_secrets`). The Agent fetches them through a scoped, mTLS-authenticated endpoint and writes them into a separate `auth.secrets.env` with mode `0600`.
3. The Agent's config provider writes the revision and swaps `current`, as it does today. The evidence now carries `restartRequired: true`.
4. Fleet Control enqueues a linked `runtime.rollout` for `auth`. Migration 33 adds `parent_operation_id` to the outbox and operations.
5. The managed Compose `auth` service gains `env_file` entries pointing at `${FLEET_CONFIG_ROOT}/fleet.runtime.auth/current/*.env` with `required: false` (Compose 2.24+). With no files present, it boots exactly as upstream.
6. Verify: GoTrue `GET /settings` reflects the changed public fields. Only then does the observed revision advance and the UI switch from "saved" to "applied".

Then extend the same producer to PostgREST (`PGRST_DB_SCHEMAS`, `PGRST_DB_MAX_ROWS`), Realtime, and Storage (file size limit). This is one domain and one env file per service, reusing Phase 1 rollout. Re-enable `runtime.config.reconcile` in `capabilities.json`. The existing drift checks (migrations 26 and 31) then become meaningful without extra work.

Done when:

- Changing `JWT_EXP` and a provider toggle in Studio changes GoTrue behavior within one rollout.
- Secrets never appear in `snapshot_canonical`. An assertion in `verify-ownership-reconciliation.sh` checks this.
- GitOps and observe-only ownership modes report drift and never write.

Phase 2 status (2026-09-28): Auth implemented for non-secret settings, pending live acceptance.

| Piece      | State                                                                                                                                                                                                                                                                                                                               |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rendering  | `lib/api/self-platform/auth-runtime.ts` renders only stored overrides as `GOTRUE_<FIELD>` into a Compose override for `auth`, escaping `$` for Compose interpolation. The operator CLI `docker/scripts/platform/apply-auth-config.ts` now uses the same module.                                                                     |
| Apply API  | `GET/POST /api/platform/auth/[ref]/config/apply`: status (nothing to apply, pending, applying, applied, failed), RBAC on `custom_config_gotrue`, recent AAL2 for POST, explicit ownership confirmation that sets the `auth` policy to direct-managed (A16), and a `runtime.config.reconcile` commit with `rollout: ["auth"]`.       |
| Agent      | The Compose provider writes the revision, recreates `auth` through the lifecycle plugin, and reports it applied only once healthy. A failed rollout restores the previous revision and converges back, or ends in manual intervention. A rollout marker covers a crash between writing and rolling out.                             |
| Target     | The lifecycle overlay advertises `runtime.config.reconcile` and adds `$FLEET_HOST_CONFIG_ROOT/auth/current/compose.yml` to the Compose files. `init-instance-env.sh` creates the placeholder; `bootstrap-config-domain.sh` does it for existing instances. Operators must include that file in their own `docker compose` commands. |
| UI         | The Auth notice follows the apply status and offers "Apply to Auth service" with an impact explanation, the list of skipped secret settings, the ownership confirmation, and an MFA step-up when the server asks for AAL2.                                                                                                          |
| Acceptance | `verify-compose-lifecycle.sh` step 4 proves an override plus rollout replaces a base `environment:` value and preserves an escaped `$`. The full Studio → Fleet Control → Agent path still needs a live run.                                                                                                                        |

Deviations from the original Phase 2 plan:

- Secrets use sealed envelopes instead of a `platform.runtime_secrets` table fetched over mTLS. See "Secret delivery channel" below.
- Instead of a separate linked `runtime.rollout` operation, the configuration task rolls the service out itself. This keeps write, rollout, verification, and rollback in one journaled task, so a failed rollout cannot leave new files on disk. No outbox migration was needed.
- Phase 1 had a gap this closes: lifecycle actions require the `runtime` ownership policy to be direct-managed, but setting it requires `runtime.config.reconcile`, which Phase 0 stopped advertising. The lifecycle overlay advertises it again now that a consumer exists. Studio still has no control for the `runtime` policy since the ownership panel was removed, so the lifecycle panel needs the same explicit confirmation the Auth apply uses.
- PostgREST, Realtime, and Storage are not wired yet. Each needs its own stored settings mapped to service environment names, and the same producer and domain pattern.

Secret delivery channel status (2026-09-28): implemented for Auth, pending live acceptance.

Studio seals each secret file to the target Agent's own key, so the secret travels inside the ordinary desired document and the durable outbox. Only the Agent can open it; the platform database, the outbox payload, Fleet Control, and evidence carry ciphertext and digests only. This replaces the planned `platform.runtime_secrets` table and mTLS fetch endpoint: nothing on the platform side can decrypt, and no second delivery path needs its own retries and audit.

| Piece      | State                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Envelope   | `supabase.fleet.sealed-secret.v1`: ephemeral X25519, HKDF-SHA256, AES-256-GCM. The additional data binds project, binding, domain, file path, and recipient key id. Go (`internal/sealedsecret`) and TypeScript (`lib/api/self-platform/sealed-secret.ts`) check one shared test vector.                                                                                                       |
| Agent key  | The Agent creates `secret-recipient.key` (mode 0600) next to its journal and sends the public key in `AgentHello`. Fleet Control stores it (migration 011, `agent_secret_recipients`) and returns it as `agent.secretRecipient` in the binding status.                                                                                                                                         |
| Compose    | A `sealed` Compose file carries an envelope instead of content. The provider decrypts every sealed file before writing anything, writes it with mode 0640 and the operator group, and reports `sealed:<envelope digest>` as its observed digest. A replaced Agent key fails with `sealed_secret_recipient_mismatch` and writes nothing.                                                        |
| Studio     | The Auth apply decrypts the stored secret overrides, renders `secrets.compose.yml`, and seals it to the Agent key. A keyed fingerprint (HMAC from `PLATFORM_ENCRYPTION_KEY`) lets Studio reuse the envelope while the secrets and key are unchanged, and detect changed secrets without decrypting. Without an Agent key, only non-secret settings apply and the UI names the skipped secrets. |
| Target     | The lifecycle overlay adds `secrets.compose.yml` to the Compose files, gives the Agent the operator group (`FLEET_OPERATOR_GID`, written by `init-instance-env.sh`), and `bootstrap-config-domain.sh` creates the placeholder. `fleet-agent-init` no longer resets the group of Fleet-owned configuration files.                                                                               |
| Acceptance | Go unit tests cover decrypt-before-write, mode and group, evidence without plaintext, wrong key, and wrong domain. The full Studio → Fleet Control → Agent path still needs a live run.                                                                                                                                                                                                        |

Next uses of the same channel:

- Edge Function secrets: done, see below.
- Database password rotation: done. Studio seals the current and new passwords into `sealedRotation`, bound to the operation ID so an envelope cannot be replayed into a later rotation. The Agent opens it in memory before running the task. Fleet Control rejects plaintext rotations (`sealed_rotation_required`) and no longer uses its sensitive-operation encryption for new operations; the Agent still accepts plaintext rotations only for operations queued before the upgrade. Studio refuses a rotation (`secret_recipient_unavailable`) when the Agent has no recipient key. The sensitive-operation storage in Fleet Control can be removed once no such operations remain.
- Recipient key rotation is by Agent replacement today. A planned rotation needs the Agent to keep the old key until Studio has resealed every domain.

Edge Function secrets status (2026-09-28): implemented for Compose targets, pending live acceptance.

| Piece    | State                                                                                                                                                                                                                                                                                                                                    |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Delivery | `platform.function_secrets` are decrypted in Studio, rendered as environment variables of the `functions` service, and sealed into `secrets.compose.yml` of the `functions` configuration domain. The Edge Runtime main service passes its environment to every worker, so functions read them with `Deno.env.get`.                      |
| Apply    | `GET/POST /api/platform/projects/[ref]/functions/secrets/apply`, with the same mechanics as the Auth apply (shared in `lib/api/self-platform/service-config-apply.ts`): `secrets:Write`, recent AAL2, explicit ownership confirmation for the `functions` policy, and a `runtime.config.reconcile` commit with `rollout: ["functions"]`. |
| UI       | The Edge Function secrets page shows whether saved secrets are applied and offers the apply. Saving a secret refreshes that status.                                                                                                                                                                                                      |
| Names    | Names the runtime reads itself (`SUPABASE_*`, `JWT_SECRET`, `VERIFY_JWT`, `EDGE_RUNTIME_*`, `DENO_*`, `FUNCTIONS_*`, and a few process variables) are rejected on write and never delivered.                                                                                                                                             |
| Target   | The lifecycle overlay loads `functions/current/secrets.compose.yml`; `init-instance-env.sh` bootstraps the `functions` domain.                                                                                                                                                                                                           |

Deviations and open items:

- Applying is explicit, not part of saving. Every apply recreates the Edge Runtime, so a save would otherwise restart functions for each secret the CLI sets.
- Kubernetes targets: done, see "Kubernetes sealed secrets" below.
- Changed secrets reach functions only after an apply, unlike the hosted platform where they apply on the next invocation.

Kubernetes sealed secrets status (2026-09-28): implemented, pending live acceptance on a cluster.

| Piece      | State                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document   | The Kubernetes reconciliation document carries `secrets`: per service, an envelope of a JSON environment map bound to `kubernetes/secrets/<service>`.                                                                                                                                                                                                                                   |
| Agent      | Opens every envelope before touching the cluster, server-side applies the Opaque Secret `supabase-fleet-<service>-secrets` in `--kubernetes-namespace` (field manager `supabase-fleet-secrets`, never forced), restarts Deployment `<service>` through a pod template digest annotation, waits for the rollout, and restores the previous Secret and annotation when the rollout fails. |
| Guardrails | Only Deployments in `--kubernetes-secret-services` receive secrets. A Secret whose data another field manager owns is an ownership conflict. Evidence reports only the envelope digest. `docker/k8s/fleet-agent/10-rbac.yaml` limits the Agent to the Fleet-owned Secret and the Deployment.                                                                                            |
| Studio     | Edge Function secrets and Auth settings apply to Kubernetes bindings (an empty set is sealed too, so deleting the last setting clears the Secret). For Auth, plain settings and secrets are sealed together. Kubernetes targets need `runtime.config.reconcile` and an Agent key.                                                                                                       |
| Manifests  | `19-functions.yaml` and `11-core.yaml` read the Secret with an optional `envFrom`; `docker/k8s/fleet-agent` deploys the Agent.                                                                                                                                                                                                                                                          |

Open items:

- Auth on Kubernetes: done. `11-core.yaml` keeps only wiring in `env`; configurable `GOTRUE_*` defaults come from the `auth-defaults` Secret (built by `deploy.sh` from `docker/.env`) and the Fleet Secret `supabase-fleet-auth-secrets` follows it in `envFrom`. Studio seals all Auth settings, not only secrets, into that Secret, and a Studio test fails if `env` sets a variable an Auth field could deliver.
- Fleet Agent on Kubernetes: `docker/k8s/fleet-agent` deploys it (RBAC, state volume, one-time enrollment Job, Agent Deployment) with `deploy.sh`; a Go test decodes the manifests strictly. It enables sealed secrets and Edge Function deployment.
- Edge Function deployment on Kubernetes: done. The Kubernetes provider used a layout (`<slug>/current`) the Edge Runtime main service cannot serve; both adapters now share one implementation and the Compose layout (`.fleet-artifacts/<slug>/revisions` plus a `.fleet-runtime-revision` marker read per request), so Kubernetes deploys need no Edge Runtime restart. The PVC `fleet-functions` is shared by the Agent and the patched `functions` Deployment, pinned to one node while it is `ReadWriteOnce`.

### Phase 3: backups on Fleet Compose stacks (3–4 weeks, parallel)

Goal: meet release gate 5 (a real backup and restore drill) on a Fleet-managed stack.

1. Confirm whether `deluxebear/postgres:17` ships pgBackRest or WAL-G. If it does not, add the tool in a derived image and document the choice.
2. Add a `backup-agent` service to `docker/fleet-managed` under an opt-in `backup` profile. It uses the `backup-operator` image with `--mode=agent`, runtime `docker`, and per-project repository settings for S3 or MinIO, with credentials passed as secrets.
3. Configure `archive_mode` and `archive_command` for the managed `db` service through the Backup Operator's documented single-primary path.
4. Enroll through the existing Backup Operator enrollment flow, and have `init-instance-env.sh` generate the variables.
5. The Docker runtime needs the Docker API to stop and start `db` during restore. Reuse the Phase 1 proxy pattern with a `db`-only allowlist, and never mount the raw socket.
6. Extend `verify-multi-instance-e2e.sh` with a scheduled backup, an isolated restore drill, and a PITR restore of project-a to a timestamp, all against disposable MinIO.

Done when the Backup and PITR pages show real jobs and recovery windows for project-a, and the drill evidence is stored under `docs/self-hosted-parity/qa-evidence/`.

### Phase 4: observability wiring (about 2 weeks, parallel)

1. Follow the M6.2 design: run one Logflare and Vector pair in the control plane, give each project a source token, and add a Vector sidecar to each managed stack. Register the endpoint and token in the project registry during attach.
2. Follow M6.3 and M6.4 for Prometheus and cAdvisor targets per project.
3. When an endpoint is missing, show capability-gated empty states instead of raw 404 or 500 responses. Fix the `disk` 500 in `pages/api/platform/projects/[ref]/disk/index.ts`.
4. Hide log drains in the Fleet profile unless a drain backend is configured.

Done when Logs Explorer, the Observability overview, and home compute metrics show data for project-a, and a project without endpoints shows an explained empty state.

### Phase 5: platform API gaps (1–2 weeks, parallel)

For each item, implement it or hide it. Never render a page backed by a 404.

| Item                               | Decision                                                          |
| ---------------------------------- | ----------------------------------------------------------------- |
| Account audit logs, org audit logs | Implement from platform audit data (`audit-login` already exists) |
| Org SSO, third-party auth          | Hide in the Fleet profile (out of scope)                          |
| GitHub connections, branching      | Hide unless a branching provider capability is observed           |
| zh-CN language switcher            | Verify it renders in the Fleet image and fix it if missing        |

### Phase 6: deferred

These wait until Phases 0–3 are in production use:

- PostgreSQL major-upgrade provider
- Read replicas and branching providers
- Kubernetes parity for runtime inventory (database security is done: the runtime only needs network access, so Compose and Kubernetes share `PostgresRuntime`)
- The T12 compact control-plane packaging, which stays deferred per the alignment matrix

## 4. Dependency view

```
Phase 0 ──► Phase 1 (lifecycle plugin) ──► Phase 2 (runtime config)
   │
   ├──► Phase 3 (backups)        ── uses the Phase 1 socket-proxy pattern
   ├──► Phase 4 (observability)
   └──► Phase 5 (API gaps)
```

## 5. Decisions (accepted 2026-09-28)

1. **Auth downtime on apply:** accept a few seconds of Auth unavailability per rollout. Every apply goes through an impact plan and AAL2 confirmation, matching the lifecycle contract. A second `auth` replica for zero downtime is not planned.
2. **Rollout mechanism:** the plugin runs the `docker compose` CLI (fixed arguments, no shell) so Compose merge and `env_file` semantics stay intact. Recreating through the Docker Engine API directly was rejected.
3. **Backup repository:** one S3-compatible repository per project. A shared repository with per-project stanzas was rejected.
4. **Phase 2 scope:** Auth first. PostgREST, Realtime, and Storage follow on the same producer once Auth passes its acceptance.

## 6. Release checkpoint

Fleet can be called feature-complete for self-hosted management when:

- Phases 0–4 are done.
- The alignment matrix shows no row whose UI accepts a change that the stack never applies.
- Release gates 1–5 in the alignment matrix pass on a fresh two-stack environment built only from published images.
