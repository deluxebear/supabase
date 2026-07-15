# T7 management trust operations

T7 gives Fleet projects a bounded, auditable trust path to Fleet Control and optional domain Operators. Embedded Studio does not expose these routes or settings and continues to use the upstream self-hosted behavior.

## Authority and secret boundary

The platform store owns organization management targets and project bindings. Fleet Control owns single-use enrollment records, Agents, certificates, heartbeat evidence, and Agent capability schemas. Studio stores only nonsecret capability projections.

Management targets contain HTTPS endpoints, trust domain, service-assertion audience, contract version, capability-schema prefix, and references to a CA and assertion key. A reference is not the secret: assertion keys use `env:FLEET_MANAGEMENT_ASSERTION_*`; CA files are restricted to `/run/secrets/fleet-management/`. Responses never include key bytes, Agent private keys, or database/control-plane credentials.

## Initial deployment

1. Run `docker/self-platform/scripts/generate-management-trust.sh` once on the control-plane host. Back up `ca.key` independently from managed project recovery domains and restrict host access.
2. Set distinct random platform and database secrets in `control-plane.env`. `FLEET_CONTROL_SERVICE_ASSERTION_KEY` is the management-target signing key accepted by every registered domain API; audience pinning keeps Fleet Control and Backup Operator assertions domain-specific.
3. Start `docker-compose.control-plane.yml`. Fleet Control serves internal outbox traffic on port 8090 and TLS/mTLS enrollment and Studio control traffic on port 8091. The Compose-only `backup-operator-tls` sidecar exposes the Backup Operator to Studio over pinned TLS without making the Operator's HTTP listener public.
4. In Organization Settings, create a management target using `https://fleet-control:8091` for the `fleet-control` domain and, when backup management is enabled, `https://backup-operator-tls:8443` for the `backup-operator` domain. Use each service's audience, the `v1` contract, the matching `supabase.fleet.` or `supabase.backup.` schema prefix, and server-side secret references.
5. In Project Settings, bind exactly one target and define the execution target, deployment kind, and allowed capability prefixes.

## Agent enrollment

Issue an enrollment token only when the Agent is ready. The token is displayed once, stored hash-only, expires after ten minutes by default, and is bound to organization, project, target, binding, execution target, deployment kind, and capability prefixes.

Run `fleet-agent-bootstrap` on the target with the exact binding values, a stable Agent ID, the enrollment server CA, and a nonempty per-domain capability JSON file. The bootstrap creates the private key locally, sends a CSR, validates the returned binding identity, and writes the key with mode 0600. Never copy the generated Agent private key into Studio or the platform database.

## Rotation, revocation, and replacement

Agents rotate before certificate expiry using their current mTLS identity. Fleet Control permits only the configured short overlap, then rejects the prior revision. Project detach or explicit trust revocation revokes the Agent, all certificates, and unused enrollment tokens. If Fleet Control is unavailable, the platform records a revoked tombstone with `target_cleanup_pending`; retry cleanup before deleting the target.

A replacement Agent uses a newly issued one-time token and the same stable Agent ID. Fleet Control revokes the prior active identity before activating the replacement. Replaying any consumed token, presenting a revoked certificate, changing binding fields, or using an incompatible protocol fails closed.

## Upgrade and rollback

Apply platform migration `14-management-trust.sql` and Fleet Control schema 3 before enabling the Fleet Studio image. Upgrade Fleet Control before Agents. Protocol major 1 is required; minor 0 is currently supported. Rollback may keep schema 3 in place because migrations are forward-only. Roll back the binaries and disable management targets; do not delete trust or audit rows. A schema-2 Fleet Control binary must not be declared ready against schema 3.

## Verification and remediation

Run `docker/self-platform/scripts/verify-management-trust.sh`. The acceptance creates two organizations/projects/targets, proves cross-target binding rejection, exercises enrollment replay/expiry/protocol/revocation through the Fleet Control integration suite, and verifies detach tombstones without managed-infrastructure deletion.

For `management_secret_unavailable` or `management_ca_unavailable`, restore the referenced secret without changing the target ID. For `incompatible`, upgrade the Agent/Fleet Control contract before issuing a new token. For `offline`, inspect certificate expiry and heartbeat evidence; do not mark capabilities available without a fresh Agent observation.
