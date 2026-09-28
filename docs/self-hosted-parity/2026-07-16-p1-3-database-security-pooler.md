# P1-3 Database security and Supavisor operations

P1-3 makes Fleet database security a typed, project-scoped operation instead of a collection of hosted-only Studio endpoints. The authoritative desired projection is `platform.database_security_policies`; Fleet Control schema 10 owns durable execution and encrypted sensitive input; the enrolled Agent owns runtime observation, apply, probe, and rollback.

## Contract and safety boundary

- Capability: `database.security.reconcile`.
- Input: `supabase.fleet.database.security.reconcile.v1`.
- Evidence: `supabase.fleet.database.security.evidence.v1`.
- Supported Compose settings: primary and read-only password rotation, Supavisor SSL enforcement and upstream CA, network CIDR allow-list, default pool size, and maximum clients. Session and transaction pooling remain simultaneously available through Supavisor's separate published ports; Fleet does not misrepresent its FIFO/LIFO scheduling field as a pool-mode toggle or expose PgBouncer-only ignored-parameter settings.
- The browser supplies only the new password. Studio resolves the active encrypted connection revision server-side and sends both credentials directly to Fleet Control over the management trust domain.
- Fleet Control stores the original typed input only as AES-GCM ciphertext. Its ordinary operation row, immutable snapshot, operation response, event history, and evidence contain `[redacted]` in place of both passwords. Decryption occurs only while the matching Agent claims the task over mTLS.
- The Agent uses fixed primary/read-only role names and server-side identifier/literal quoting. User input cannot select an arbitrary SQL role or statement.

## Apply, verification, and rollback

The Compose provider snapshots the current Supavisor tenant and Fleet-owned state, resolves TLS CA files only below the configured allow-list root, updates the tenant with parameterized SQL, rotates a fixed role when requested, and then probes:

1. the operator administration identity;
2. the rotated direct role when applicable;
3. the project-local Supavisor endpoint, with bounded retry for credential-cache convergence.

An empty network list is normalized to Supavisor's allow-all CIDRs. Invalid or missing TLS CA references fail before activation. Any failed apply or probe restores the previous tenant settings and, when necessary, the old password. If rollback itself cannot be proven, evidence enters `manual-intervention` with separate apply and rollback error codes.

The Agent uses the project-isolated `db-<project-ref>` management-network alias. It must not use the shared `db` alias because multiple attached Compose projects can otherwise resolve the same unqualified name.

## Studio behavior

Fleet Database Settings now renders connection profiles followed by real settings cards for SSL/CA, CIDRs, Supavisor limits, and primary/read-only password rotation. GET and mutation routes require the Fleet profile, project RBAC, an active management binding, and a live `database.security.reconcile` capability. The page represents `ready`, `applying`, and `failed` states explicitly; it does not reuse hosted PgBouncer, IPv4 add-on, or entitlement UI.

After a successful password operation, Studio encrypts the new credential into both `platform.projects` and the active connection revision before returning success. API responses never contain the current or new password.

Update (2026-09-28): passwords reach the Agent as a sealed envelope (`sealedRotation`, `supabase.fleet.sealed-secret.v1`) sealed to the Agent's recipient key and bound to the operation ID. Fleet Control rejects plaintext rotations with `sealed_rotation_required`, so neither its database nor its encryption key can recover a password. Studio refuses the rotation with `secret_recipient_unavailable` when the Agent has not published a key. See the secret delivery channel in the [Fleet completion roadmap](./2026-09-28-fleet-completion-roadmap.md).

## Verification completed

- Go unit tests cover strict validation, successful evidence, failed-probe rollback, encrypted Fleet storage, claim-time decryption, and fail-closed missing encryption keys.
- Opt-in Compose integration tests cover Supavisor snapshot/apply/probe, direct password rotation/restore, and bounded Supavisor convergence after rotation.
- Studio Vitest verifies that the connection projection is updated only after a successful Fleet operation and that neither password is present in the result.
- The production Fleet Control/Agent image and production Fleet Studio image built successfully; Fleet Control readiness reports schema 10.
- On disposable `project-b`, a normal 15/200 pool configuration succeeded with healthy direct and pooled probes. A missing TLS CA operation failed and restored SSL off plus the previous pool configuration. A generated primary password was applied, verified through direct and pooled connections, confirmed absent from plaintext Fleet columns, and rotated back to the original password. Database, Auth, REST, Storage, Kong, Supavisor, and the Agent remained healthy.
- The deployed authenticated Studio API refreshed the live Agent capability lease before authorization, applied pool size 16 at generation 3, then restored pool size 15 at generation 4; both operations returned HTTP 200 and `ready`. No destructive database operation was run on `project-a`.
