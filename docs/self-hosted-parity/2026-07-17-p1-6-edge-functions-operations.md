# P1-6 Edge Functions operations

P1-6 closes the Fleet Studio Edge Functions deployment and secret-management gap without changing Embedded Studio's mounted-directory behavior.

## Control-plane contract

- `platform.function_secrets` stores project-scoped encrypted ciphertext, a SHA-256 digest, version, actor, and timestamps. The API supports list, upsert, and delete under project RBAC, returns metadata only, and never returns plaintext or ciphertext.
- Canonical function bundles remain bounded, project-scoped, content-addressed, and immutable. A deployment uses generation CAS and an idempotency key before the platform outbox can create Agent work.
- `platform.function_deployments.evidence` stores typed activation, probe, rollback, active/previous digest, generation, remediation, and observation evidence through a least-privilege security-definer projection.
- Fleet Studio disables deployment when the live `functions.deploy` capability is unavailable or expired. The function list shows deployment state, revision, probe log, and the digest restored by rollback.

## Compose runtime behavior

Fleet Control initializes the artifact volume for its non-root runtime before accepting uploads. Issuing a replacement enrollment token no longer demotes an already active binding.

The Agent retains every bundle under the immutable project/revision tree, materializes an owned runtime directory atomically, and records the selected digest. The Edge Runtime router loads the digest-specific immutable path and adds `X-Supabase-Fleet-Revision` to the response. The Agent probe requires both a successful HTTP response and the expected revision header, so a stale worker or delayed bind-mount projection cannot produce a false success. Project probes use the unique `kong-<project-ref>` management alias rather than the ambiguous shared `kong` name.

If the desired revision fails its bounded probe, the Agent restores the previous immutable digest and runtime revision. A failed rollback is projected as `manual-intervention`; it is never reported as active.

## Live acceptance

The production-like control plane and only `project-b` were upgraded. `project-a` was not restarted or mutated.

1. Secret `P1_6_ACCEPTANCE_TOKEN` was created, listed as name/digest/timestamp metadata with no plaintext or ciphertext, and deleted successfully.
2. Revision v1 of `p1-6-acceptance` deployed through Studio, Fleet Control, the durable outbox, mTLS Agent stream, and Edge Runtime. The public project gateway returned HTTP 200 with `{ "ok": true, "revision": "v1" }` and the matching revision digest header.
3. Revision v2 deliberately returned HTTP 500. Its probe failed, generation 15 finished as `rolled-back`, the typed evidence recorded `Edge Runtime probe returned HTTP 500`, and the active digest matched the previous v1 digest.
4. Invoking the same public URL after rollback again returned HTTP 200, body revision v1, and the v1 digest header.
5. Studio rendered `Rolled back`, the deployment revision, the probe log, and the restored digest. Browser evidence: `/.gstack/qa-reports/screenshots/p1-6-functions-deployment-rollback.png`.

The focused secrets, deployment, capability-liveness, provider, Agent, and projection tests pass. The disposable T9 acceptance continues to cover immutable upload, idempotent replay/conflict, two-project isolation, rollback, and manual-intervention behavior.
