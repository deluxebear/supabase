# T6 honest attachment operations

This runbook describes the shipped T6 Fleet contract. It does not enable T7
management-target enrollment or T8 reconciliation providers.

## Contract and authority

`platform.projects` remains the active server-side connection projection.
`platform.project_connection_revisions` is the write-only revision history,
`platform.stack_bindings` is the attachment identity and independent-status
projection, and `platform.project_capabilities` is the timestamped capability
projection. All three are owned by the platform control store.

Fleet project creation is attach-only. `shared-db` creation is rejected because
it cannot satisfy the one-project-to-one-stack identity invariant. Before a row
is created, Studio proves PostgreSQL system/database history and permissions,
probes Gateway, Auth, REST, Storage, Realtime, and JWKS, and verifies that no
active binding has the same SHA-256 stack fingerprint. The fingerprint combines
the PostgreSQL system identifier, gateway origin, and Auth issuer. Database OID,
checkpoint timeline, PostgreSQL major version, and JWKS key IDs remain evidence
in the preflight report rather than unstable fingerprint inputs.

Supported key modes are `legacy-jwt`, `asymmetric-jwks`, and `mixed`. TLS modes
are `disable`, `prefer`, `require`, `verify-ca`, and `verify-full`; the CA value
is an operator-managed filesystem reference, never raw browser-delivered CA
material. A separate read-only user and password are optional; when the password
is absent, the primary database password is used with the read-only identity.
Secrets are encrypted before persistence and are never returned to the browser.

## Authorization and failure behavior

Fleet attach, capability/status read, connection update, and detach require all
of the following before connection secrets are resolved:

1. canonical Fleet build profile;
2. matching static profile capability;
3. authenticated platform session;
4. project/organization-scoped RBAC and isolation;
5. available project capability for the requested operation.

Missing or stale capabilities return explicit blockers. A connection update
first creates a `validating` revision. Failed preflight marks only that candidate
`failed` and schedules its secret purge; the active revision remains routable.
A successful validation atomically moves the former active revision to a
24-hour rollback state and promotes the candidate. A verified binding cannot be
silently retargeted to a different stack; detach it first.

Health is not a single boolean. Attachment state, data-plane health, management
connectivity, drift, and operation state carry their own observations. An
offline Agent therefore does not rewrite a healthy data plane as unhealthy.

## Detach and retention

`DELETE /api/platform/projects/{ref}` means Fleet detach. It rejects an active
operation, tombstones the project, revokes the fingerprint proof, marks all
capabilities unavailable, retains audit and connection history, and schedules
secret purge. If management connectivity is offline it records target cleanup
as pending. It does not delete the stack, database, containers, namespaces,
PVCs, backup references, or audit history. This is ADR-014; T6 did not require a
new or superseding ADR.

## Deployment and verification

Migration `13-honest-attachment.sql` is applied by the existing checksum-locked
platform migration runner. Existing rows receive an explicit unverified legacy
binding and stay routable; saving their connection settings runs the new proof.

Run the disposable database/Compose acceptance from the repository root:

```bash
docker/self-platform/scripts/verify-honest-attachment.sh
```

Run focused Studio coverage:

```bash
pnpm --filter studio exec vitest run \
  lib/api/self-platform/attachment.test.ts \
  lib/api/self-platform/projects-admin.test.ts \
  pages/api/platform/projects/index.post.test.ts \
  'pages/api/platform/projects/[ref]/capabilities.test.ts' \
  'pages/api/platform/projects/[ref]/index.delete.test.ts' \
  components/interfaces/SelfPlatform/SelfPlatformAttachmentStatusPanel.test.tsx
pnpm --filter studio exec tsc --noEmit -p tsconfig.json
```

The Compose acceptance creates two project rows and checks duplicate fingerprint
rejection, offline-target cleanup intent, retained revisions/audit/tombstone,
non-deletion of a managed-infrastructure marker, and fingerprint reuse only
after explicit detach. API and UI suites cover asymmetric JWKS evidence, stale
sessions, failed connection candidates, capability blockers, and independent
offline-management/data-plane states. Embedded zero-break tests verify that
Fleet-only methods remain unavailable outside the Fleet profile.
