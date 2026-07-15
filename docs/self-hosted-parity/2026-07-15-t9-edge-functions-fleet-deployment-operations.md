# T9 Edge Functions Fleet deployment operations

T9 adds remote Edge Function deployment only to the canonical Fleet profile.
Cloud keeps the hosted Functions API. Embedded and CLI keep the upstream
self-hosted mounted-directory behavior. Fleet never reads or writes an attached
project's function source through the central Studio filesystem.

## Authority, capability, and authorization

The platform database (schema 16) owns the mutable desired/active deployment
pointer, generation, ownership policy, audit record, and terminal observation.
Fleet Control schema 5 owns project-scoped immutable artifact bytes and durable
operations. The Agent owns only the target-side installed projection and returns
typed evidence; it cannot change platform desired state.

The stable capability is `functions.deploy`, with input
`supabase.fleet.functions.deploy.v1` and evidence
`supabase.fleet.functions.deploy.evidence.v1`. Reads require `functions.read`.
Every Studio action is gated, in order, by Fleet profile/static capability,
project-scoped RBAC, current project capability, active project/target/binding,
adapter compatibility, and the `functions` ownership policy. Live mutation is
allowed only in `direct-managed`; `observe-only` and `gitops-managed` fail with
`ownership_conflict`.

## Artifact and request boundary

Studio's BFF accepts at most 512 regular source files, 4 MiB per file and 20 MiB
per canonical bundle. It rejects absolute/traversing/backslash paths, duplicate
paths, unknown or symlink-shaped fields, missing import maps or entrypoints,
unsupported entrypoint extensions, invalid base64, and changed size/digest. It
sorts the file list, computes SHA-256, uploads bytes with a project-bound
`fleet.artifacts.write` assertion, then transactionally commits the deployment
pointer. Audit, operation, and platform rows contain metadata/digests, never
source bytes or management credentials.

Fleet Control stores bytes under a project hash and digest in a dedicated
`FLEET_CONTROL_ARTIFACT_ROOT`; metadata remains in its independent database.
The same digest is immutable and idempotent within a project. Artifact reads
require `fleet.artifacts.read` for the exact project. The Agent downloads the
artifact over its existing mTLS connection only when certificate Agent ID and
project/target/binding all match.

## Target providers

### Docker Compose

Set `FLEET_AGENT_FUNCTION_ARTIFACT_ROOT` to a Fleet-owned host directory and
mount the enrolled project's hashed subdirectory at `/home/deno/functions` in
Edge Runtime. The subdirectory name is the first 24 hex characters of
SHA-256(project ref). The Agent stores immutable revisions in
`.fleet-artifacts/<slug>/revisions/<digest>` and maintains a Fleet-owned
`<slug>` symlink to `.fleet-artifacts/<slug>/current`. Never point this root at
the user's source checkout.

The upstream self-hosted main service creates a worker from
`/home/deno/functions/<slug>` on each request. Consequently, the atomic pointer
switch is the Compose rollout; no fork-specific reload endpoint or Edge Runtime
change is required. The Agent performs a bounded invocation probe against the
fixed operator-configured `FLEET_AGENT_FUNCTION_PROBE_URL`. Deletes pass only
when the probe returns 404. A failed probe restores the prior pointer; a failed
restore enters `manual-intervention` with remediation.

### Kubernetes

Mount `FLEET_AGENT_FUNCTION_ARTIFACT_ROOT` and the corresponding project
artifact view from a PVC/CSI/init-container strategy into Edge Runtime. The
Agent writes large bytes only to that volume. It uses server-side apply with
field manager `supabase-fleet-functions`, `force=false`, to update a bounded
hashed revision annotation on the allowlisted `apps/v1` Deployment, waits for
observed generation/updated/available replicas, then runs the invocation probe.
It never serializes a function bundle into a ConfigMap. Grant the Agent only
`get` and `patch` on the configured namespace and Deployment.

## Deployment and compatibility

Fleet Control requires:

```text
FLEET_CONTROL_ARTIFACT_ROOT=/var/lib/fleet-artifacts
```

Run one enrolled `fleet-agent` per binding with its durable journal/lock, mTLS
identity, adapter, artifact root and fixed probe URL. Compose needs the shared
project directory described above. Kubernetes additionally requires
`FLEET_AGENT_KUBERNETES_NAMESPACE` and
`FLEET_AGENT_KUBERNETES_EDGE_RUNTIME_DEPLOYMENT`; in-cluster credentials or an
explicit kubeconfig must be least privilege. Do not advertise
`functions.deploy` unless the probe URL and provider configuration are valid.

The compatibility boundary is Agent/Fleet protocol major 1, Fleet Control
schema 5, platform schema 16, Docker Compose Edge Runtime main-service behavior
as shipped in `supabase/edge-runtime:v1.74.0`, or Kubernetes `apps/v1`
Deployments. Unsupported adapters, schema versions, stale Agent evidence, and
unavailable providers fail explicitly.

## Failure handling, upgrade, and rollback

- `artifact_unavailable` or `artifact_conflict`: verify the project-bound
  artifact volume and Fleet Control metadata; never replace digest bytes.
- `rollout_probe_failed`: the prior revision was restored. Inspect immutable
  source and Edge Runtime logs/events, then create a new generation.
- `manual_intervention_required`: stop retries, restore the recorded previous
  pointer/workload revision, invoke the function manually, then deploy a fresh
  generation. The platform retains the last known active digest.
- `ownership_conflict`: remove or explicitly transfer the foreign function path
  or Kubernetes field. Fleet never overwrites/forces it.
- `capability_stale`, `binding_revoked`, or `capability_unavailable`: restore
  Agent heartbeat/trust and resync the binding before retrying.

Back up the platform database, Fleet Control database, and artifact volume as
independent recovery domains before rollout. Apply platform migration 16 and
Fleet Control migration 005 before enabling the Studio capability. Applied
migrations are checksum locked; use a forward repair rather than editing them.
Roll back binaries only to versions supporting schema 5/16. Artifact references
and bytes are retained across binary rollback; stop new commits first and never
delete a digest still referenced by desired, active, or previous pointers.

## Verification

From the repository root:

```bash
cd apps/backup-operator
make generate check-generated build test
go vet ./...

cd ../..
docker/self-platform/scripts/verify-edge-function-deployments.sh
pnpm test:studio
pnpm typecheck
NEXT_PUBLIC_STUDIO_DEPLOYMENT_PROFILE=embedded NEXT_PUBLIC_IS_PLATFORM=false NEXT_PUBLIC_SELF_PLATFORM=false pnpm build --filter=studio
NEXT_PUBLIC_STUDIO_DEPLOYMENT_PROFILE=fleet NEXT_PUBLIC_IS_PLATFORM=true NEXT_PUBLIC_SELF_PLATFORM=true pnpm build --filter=studio
```

The disposable acceptance runs all platform migrations in PostgreSQL and proves
idempotent commit, project isolation, audit, exact generation/revision CAS,
failed-probe rollback and manual-intervention projection. Go tests cover path,
symlink, digest, permission and size validation, durable Agent replay, a 2 MiB
Kubernetes artifact kept outside ConfigMaps, Compose's upstream runtime view,
and project-bound artifact storage.
