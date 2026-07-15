# T8 ownership-safe reconciliation operations

This runbook describes the T8 Fleet configuration reconciliation boundary. The
platform database is authoritative for the selected ownership policy and desired
revision. Fleet Control owns durable operation dispatch. The Agent reports typed
observations; it is never an alternative desired-state authority.

## Availability and authorization

The stable capability is `runtime.config.reconcile`. Studio exposes ownership
controls only in the canonical Fleet profile with the static
`ownershipReconciliation` capability. Every request then requires the matching
project capability, project-scoped RBAC, and the active project/target/binding
tuple. Reads require `configuration.ownership.read`; updates require
`configuration.ownership.update`; selecting `direct-managed` also requires an
Agent that currently advertises `runtime.config.reconcile`.

Cloud and Embedded do not expose the Fleet route or UI. Embedded Studio remains
identical to upstream self-hosted Studio apart from the existing zh-CN locale.
CLI callers use the same project capability, RBAC, schema, and binding checks.

## Ownership modes

| Mode             | Runtime mutation         | Authority and result                                                                                                    |
| ---------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `observe-only`   | none                     | Agent reports digest/drift; external files and fields remain authoritative.                                             |
| `direct-managed` | Fleet-owned content only | Agent may atomically replace its generated Compose revision or use Kubernetes server-side apply for allowlisted fields. |
| `gitops-managed` | none                     | Git is authoritative; Agent reports drift and remediation evidence.                                                     |

The input schema is `supabase.fleet.runtime.config.reconcile.v1`; evidence uses
`supabase.fleet.runtime.config.evidence.v1`. Unknown fields, modes, adapters,
paths, fields, schema versions, capabilities, or identity tuples fail before a
side effect. Desired and observed generations are separate and stale evidence
is rejected by compare-and-swap projection.

### Compose

Configure `FLEET_AGENT_COMPOSE_OWNED_ROOT` as a directory reserved exclusively
for generated Fleet fragments (default `/var/lib/supabase-fleet/config`). The
Agent writes a project/target/binding/domain owner marker and an immutable
revision directory, then atomically switches the current symlink. It never
rewrites the user's Compose file, `.env`, bind-mounted configuration, or a
non-empty directory without its matching marker. A foreign marker or preexisting
content returns `ownership_conflict` with remediation and leaves all content
unchanged.

### Kubernetes

The Kubernetes adapter uses server-side apply with field manager
`supabase-fleet`, `force=false`, and an operator-configured JSON-pointer
allowlist. The desired document must declare each owned field. A field outside
the allowlist or already owned by another manager returns `ownership_conflict`;
Fleet does not steal it. Observe-only and GitOps modes never call apply.

## Deployment

Fleet Control schema 4 adds durable Agent task/evidence/error state. Its Agent
listener is a distinct mTLS-only gRPC endpoint, normally port 8092:

```text
FLEET_CONTROL_AGENT_LISTEN=0.0.0.0:8092
FLEET_CONTROL_AGENT_GRPC_PORT=8092
```

Run one `fleet-agent` for an enrolled binding. Required flags or corresponding
`FLEET_AGENT_*` variables include the control address, client certificate/key,
server CA/name, agent/project/target/binding/node identities, and adapter. For
Compose, mount only the Fleet-owned root read-write. For Kubernetes, use a
dedicated least-privilege service account and set
`FLEET_AGENT_KUBERNETES_ALLOWED_FIELD_PREFIXES`; do not grant wildcard mutation
solely for Fleet.

The Agent journal and singleton lock must be on durable local storage. Reconnect
replays an applying task with the same operation ID and fencing token, so a
restart cannot create a second mutation. Certificate revocation, binding
replacement, project mismatch, capability expiry, or stale fencing fails closed.

## Failure handling

- `ownership_conflict`: inspect evidence for the resource, field/current owner,
  and remediation. Move the content into the Fleet-owned Compose root or transfer
  the Kubernetes field deliberately; never enable force ownership as a shortcut.
- `binding_revoked`: re-enroll against the active project binding. Do not copy an
  Agent identity between projects or targets.
- `capability_unavailable`: verify Agent heartbeat, adapter support, protocol
  major 1, and the binding capability prefix.
- `stale_revision` or `stale_generation`: refresh policy/desired state and retry;
  do not project the old observation.

Systemd and bare-metal targets may use observe-only or GitOps policy reporting,
but direct reconciliation is unsupported until a versioned provider is added.
Compose and Kubernetes are the T8 direct-managed compatibility boundary.

## Upgrade, repair, and verification

Back up the independent platform and Fleet Control databases before applying
platform migration 15 and Fleet Control migration 004. Applied migration files
are checksum locked. Roll forward with a new migration; do not edit or remove an
applied migration. Roll back the binary only to a version that understands Fleet
schema 4 and protocol major 1. If that is impossible, restore both independent
stores from the pre-upgrade backup before starting the old binary.

Run from the repository root:

```bash
cd apps/backup-operator
make generate check-generated build test
go vet ./...

cd ../..
docker/self-platform/scripts/verify-ownership-reconciliation.sh
pnpm test:studio
pnpm typecheck
NEXT_PUBLIC_STUDIO_DEPLOYMENT_PROFILE=embedded NEXT_PUBLIC_IS_PLATFORM=false NEXT_PUBLIC_SELF_PLATFORM=false pnpm build --filter=studio
NEXT_PUBLIC_STUDIO_DEPLOYMENT_PROFILE=fleet NEXT_PUBLIC_IS_PLATFORM=true NEXT_PUBLIC_SELF_PLATFORM=true pnpm build --filter=studio
```

The disposable acceptance verifies project isolation, policy revision CAS,
conflict projection, audit rows, and byte-for-byte preservation of user-owned
Compose and Kubernetes fields. The Go provider tests additionally prove that
observe-only/GitOps do not mutate and Kubernetes apply always uses
`supabase-fleet` with force disabled.
