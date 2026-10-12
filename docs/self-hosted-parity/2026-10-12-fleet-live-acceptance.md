# Fleet live acceptance (2026-10-12)

- Date: 2026-10-12
- Branch: `custom/main` at `3546e7c829`, plus the fixes listed in section 3
- Environment: one macOS host (OrbStack Docker), the local Fleet control plane (`supabase-fleet-control`) and managed project `project-d` (`supabase-managed-d`, Compose adapter, Envoy gateway)
- Inputs: the [completion roadmap](./2026-09-28-fleet-completion-roadmap.md) phases marked "pending live acceptance"

## 1. Summary

The Studio → Fleet Control → Agent pipeline works end to end on a live Compose stack for Auth apply, Edge Function secrets, lifecycle restart and rollout, database security, and runtime inventory. Reaching that result required three fixes found during the run. The most serious one: no Agent ever renewed its mTLS certificate, so every Agent went permanently offline at its first reconnect after the certificate lifetime (24 hours). `project-d` had been offline for that reason since its certificate expired on 2026-10-01.

## 2. Results

### Disposable acceptance scripts

All run with a Fleet image built from `3546e7c829`.

| Script                                | Result |
| ------------------------------------- | ------ |
| `verify-compose-lifecycle.sh`         | PASS   |
| `verify-platform-state-authority.sh`  | PASS   |
| `verify-honest-attachment.sh`         | PASS   |
| `verify-management-trust.sh`          | PASS   |
| `verify-ownership-reconciliation.sh`  | PASS   |
| `verify-edge-function-deployments.sh` | PASS   |

`go test ./...` in `apps/backup-operator` passes. On macOS, `internal/dockerproxy` and `internal/fleetinventory` need a short `TMPDIR` (for example `/tmp/g`), because their Unix socket paths exceed the 104-byte limit under the default temporary directory. `internal/app` `TestRunWithDependenciesConfiguresManagementSources` fails intermittently with and without the changes in this report.

### Live path on project-d

Each write ran through the Studio API with a recent AAL2 session, and was checked against the running service, not only against the platform database.

| Capability                                       | Evidence                                                                                                                                                                                       | Result |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| Auth apply                                       | `MAILER_AUTOCONFIRM` false → true: saved state `pending`, apply `202`, `applied` after 12 s, `auth` recreated healthy, GoTrue `/settings` reports the new value. Reverted the same way in 9 s. | PASS   |
| Auth apply guards                                | AAL1 session → `403 aal2_required`; concurrent apply → `409 apply_in_progress`. Ownership confirmation is not asked again once `auth` is direct-managed, as designed.                          | PASS   |
| Edge Function secrets                            | New secret absent from the Edge Runtime before apply, present after apply (9 s), removed after delete and apply (12 s).                                                                        | PASS   |
| Lifecycle restart and rollout (`rest`)           | Plan `201` with impact, execute `202`, Fleet Control operation `succeeded` within about 6 s, container restarted or recreated healthy, gateway serves REST.                                    | PASS   |
| Database security                                | Pool size 20 → 21 → 20: Supavisor `_supavisor.tenants` follows each change synchronously.                                                                                                      | PASS   |
| Runtime inventory                                | Complete evidence: disk, compute, every container with image and health.                                                                                                                       | PASS   |
| Observer Docker proxy (roadmap 0.4)              | Through the proxy: `POST /containers/{db}/stop` → `403`, another project's container → `403`, own container → `200`.                                                                           | PASS   |
| Agent certificate renewal (fix 3.1)              | With a temporary 15-minute TTL, the Agent renewed at two thirds of each lifetime (17:37:50, 17:46:10, 17:54:30, 18:02:50 UTC), reconnected within the same second, and stayed online.          | PASS   |
| Agent restart diagnostics (fix 3.1)              | With the expired certificate the Agent now logs `certificate has expired; enroll the Agent again` and the server's `tls: expired certificate`, where it previously logged nothing.             | PASS   |
| Capability freshness after idle (fixes 3.2, 3.3) | With Agent evidence more than 30 s old: ownership update `200`, lifecycle plan `201` and execute `202`, Backup Operator proxy passes the capability check.                                     | PASS   |

## 3. Fixes made during the run

### 3.1 Agent mTLS certificate renewal (critical)

Fleet Control exposed `POST /platform/fleet/v1/agents/{agentId}/certificate-requests`, and the [T7 operations guide](./2026-07-15-t7-management-trust-operations.md) states that Agents rotate before expiry, but no Agent code called it. TLS checks expiry only at the handshake, so an Agent stayed online on its existing stream until the first reconnect after expiry, then failed every handshake. Connection errors were discarded, so the Agent log stayed empty.

- `internal/fleetagent/certificate_rotation.go`: `CertificateRotator` renews at two thirds of the lifetime using the current certificate, with a fresh key per renewal. New files are written as `.next` and renamed key first; `RecoverPendingCertificate` completes or discards an interrupted replacement on startup. The existing TLS loader picks up the new pair at the next handshake.
- `internal/fleetagent/client.go`: logs connection failures (repeated identical errors at most every 5 minutes) and session acknowledgements, and reconnects immediately after a renewal once any running task has reported its result.
- `cmd/fleet-agent`: wires both; `FLEET_AGENT_ENROLLMENT_URL` (already set for Kubernetes) now also reaches the Compose `fleet-agent` service.
- `internal/fleetcontrol/agent_server.go`: every heartbeat revalidates the session certificate, so expiry or revocation now ends a long-lived stream instead of leaving it online.

An Agent whose certificate already expired must still be enrolled again. `project-d` was enrolled again through `POST /api/platform/projects/project-d/management-binding/enrollment-token` and `fleet-agent-bootstrap`.

### 3.2 Lifecycle actions used stale Agent evidence

Agent capability evidence is valid for 30 seconds. Functions, database security, runtime inventory, and service configuration apply refresh it through `syncProjectManagementBinding` before checking a capability; lifecycle did not. In practice a lifecycle action failed with `capability_stale` whenever more than 30 seconds passed after another Agent-backed request, for example while reading the impact plan and completing MFA. `lib/api/self-platform/lifecycle.ts` now refreshes first.

### 3.3 Same defect in two more routes

- `PUT /api/platform/projects/[ref]/ownership-policies` checked `runtime.config.reconcile` without refreshing.
- The Fleet Backup Operator proxy checked `management.agent.connect` without refreshing. It now refreshes and, if Fleet Control is unreachable, lets the capability check report the stale evidence.

## 4. Findings

All six findings are fixed; see section 6 for the fixes and their live verification.

| Finding                                                                                                                                                                                                                                                                                                                                                                                                  | Severity |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| Edge Functions that use `@supabase/server` (`withSupabase`) reject every key through the Fleet Envoy gateway. The Fleet `functions` branch of the apikey filter in `docker/volumes/api/envoy/lds.template.yaml` (`11eddde74f`) translates Fleet-managed `sb_` keys into legacy JWTs before the upstream functions filter (`c8b665caf2`) runs, so the function receives a legacy JWT. REST is unaffected. | High     |
| No Studio control sets the `runtime` ownership policy, so every lifecycle action in the UI ends in `ownership_conflict`. The API works. The roadmap already notes that the lifecycle panel needs the same explicit confirmation as Auth apply.                                                                                                                                                           | High     |
| Studio shows stored overrides on top of its own defaults, not the values the service runs with. On `project-d`, Auth showed `SMS_AUTOCONFIRM` false while GoTrue ran with phone autoconfirm on (`ENABLE_PHONE_AUTOCONFIRM=true`), and database security showed pool 15 / 200 while Supavisor ran 20 / 100 until the first apply. A save based on the displayed values overwrites the running ones.       | Medium   |
| `platform.operation_summaries` keeps lifecycle operations at `queued` after Fleet Control reports `succeeded`. The operation detail route reads Fleet Control directly and is correct; the summary table is not refreshed for lifecycle.                                                                                                                                                                 | Low      |
| Replaced Agent certificates keep the state `overlap` after their overlap window ends. Validation compares times, so this is cosmetic.                                                                                                                                                                                                                                                                    | Low      |
| `verify-ownership-reconciliation.sh` selects Agent tests with `-run 'Ownership\|Reconcile\|OperationClaim'`, which matches no test in `internal/fleetagent`. The executor tests run in `go test ./...` but not in that script.                                                                                                                                                                           | Low      |

## 5. State left on the environment

- Fleet Control, the outbox dispatcher, and the `project-d` Agent run images built from the working tree with the section 6 fixes: `supabase-fleet-control:acceptance-openfix` (control plane) and `supabase-fleet-control:acceptance-rotation` (Agent, unchanged by section 6). Studio runs `supabase-studio:fleet-openfix`. `control-plane.env` and `project-d.env` keep the previous image names as rollback comments.
- Platform migration `35-lifecycle-operation-projection.sql` is applied.
- `FLEET_CONTROL_AGENT_CERTIFICATE_TTL` is back to `24h`.
- The `runtime` ownership policy of `project-d` is `observe-only` (it had no policy before the first run, which lifecycle treats the same way). Auth, Edge Function secrets, and database security values are back to their values before the run.
- The `project-d` API key set is unchanged: the temporary secret key was created and deleted again. As a result, `functions` now carries the `SUPABASE_PUBLISHABLE_KEYS` and `SUPABASE_SECRET_KEYS` maps.
- The temporary acceptance account, its profile, and its organization membership were deleted.

## 6. Follow-up fixes

Each fix has unit tests, and each was verified on `project-d` with the rebuilt images.

| Finding                                       | Fix                                                                                                                                                                                                                                                                                                                                                                       | Live result                                                                                                                                                                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@supabase/server` functions reject every key | The Fleet `functions` branch of the apikey filter is removed. The functions filter accepts Fleet-registered keys like the single keys: `apikey` stays unchanged and the internal JWT goes into `sb-api-key`. The `api-keys` domain also delivers `SUPABASE_PUBLISHABLE_KEYS` and `SUPABASE_SECRET_KEYS` to `functions`, with the oldest key of each type named `default`. | Before: every key `401`. After: the default publishable and secret keys `200`; a key with another name is rejected by `withSupabase` with its hint to use `auth: 'publishable:<name>'`; an unregistered key gets `401` from the gateway. Smoke test passes. |
| Fleet revision probe with a secret key        | The functions router accepts the gateway-minted service role JWT from `sb-api-key`, so the probe no longer depends on the gateway rewriting `Authorization`.                                                                                                                                                                                                              | `envoy-smoke.py`: all 18 checks pass, including `function-secret-1`.                                                                                                                                                                                        |
| No Studio control for the `runtime` policy    | Impact plans report whether Fleet owns the action's domain. The lifecycle panel then asks for confirmation, and execution sets the policy to direct-managed only after every other plan check passes.                                                                                                                                                                     | Execute without confirmation: `409 ownership_confirmation_required`, policy unchanged. With confirmation: `202`, policy direct-managed, `rest` restarted healthy.                                                                                           |
| Studio shows defaults, not running values     | Auth settings without a stored override show GoTrue's `/settings` values. Until Fleet applies a database security policy, the pooler and network fields show the Supavisor tenant from the `_supabase` catalog.                                                                                                                                                           | `SMS_AUTOCONFIRM` shows `true` (GoTrue runs with phone autoconfirm). An unapplied policy shows 20 / 100 instead of 15 / 200.                                                                                                                                |
| Lifecycle summaries stay `queued`             | The outbox dispatcher projects Fleet Control's terminal state for lifecycle operations (migration 35).                                                                                                                                                                                                                                                                    | Both earlier `queued` operations became `applied`, and a new restart reached `applied` within seconds.                                                                                                                                                      |
| Replaced certificates stay `overlap`          | Agent heartbeats, including the stream heartbeat, mark certificates whose overlap ended as `replaced`.                                                                                                                                                                                                                                                                    | Revisions 3–7 changed from `overlap` to `replaced` within seconds of reconnecting.                                                                                                                                                                          |
| Ownership script misses the executor tests    | `verify-ownership-reconciliation.sh` also selects `Executor` tests.                                                                                                                                                                                                                                                                                                       | The pattern now runs the four executor tests.                                                                                                                                                                                                               |

Stacks whose API key set was applied before this change receive the function key maps with the next key change.
