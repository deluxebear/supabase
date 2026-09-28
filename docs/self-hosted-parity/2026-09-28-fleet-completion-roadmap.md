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
| Database security (pooler SSL, CIDR allowlist, pool size, role password rotation) | `fleetdatabase/compose_runtime.go` updates `_supavisor.tenants`, `ALTER ROLE`, then syncs the registry                                                        | **Works** (Compose only)                               |
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
- Kubernetes parity for database security and inventory
- The T12 compact control-plane packaging, which stays deferred per the alignment matrix

## 4. Dependency view

```
Phase 0 ──► Phase 1 (lifecycle plugin) ──► Phase 2 (runtime config)
   │
   ├──► Phase 3 (backups)        ── uses the Phase 1 socket-proxy pattern
   ├──► Phase 4 (observability)
   └──► Phase 5 (API gaps)
```

## 5. Open decisions

1. **Auth downtime on apply.** A rollout recreates the `auth` container, which causes a few seconds of Auth unavailability. The options are to accept this with an explicit impact plan and AAL2 confirmation (recommended, matching the lifecycle contract) or to run a second `auth` replica behind Kong for zero downtime.
2. **Rollout mechanism.** The options are the `docker compose` CLI inside the plugin (recommended, because it keeps Compose semantics and `env_file` handling) or recreating through the Docker Engine API directly, which avoids shipping the Compose CLI but reimplements Compose merge logic.
3. **Backup repository.** The options are S3-compatible object storage per project (recommended) or a shared repository with per-project stanzas.
4. **Scope of runtime config in Phase 2.** The options are Auth only first (recommended) or Auth, PostgREST, Realtime, and Storage together.

## 6. Release checkpoint

Fleet can be called feature-complete for self-hosted management when:

- Phases 0–4 are done.
- The alignment matrix shows no row whose UI accepts a change that the stack never applies.
- Release gates 1–5 in the alignment matrix pass on a fresh two-stack environment built only from published images.
