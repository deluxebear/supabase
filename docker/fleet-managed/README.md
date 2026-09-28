# Fleet-managed upstream Compose

This overlay keeps `docker/docker-compose.yml` as the upstream data-plane base
and adds only the target-side wiring required by a separately deployed Fleet
Studio. Supabase CLI is not used.

The embedded Studio service is disabled by default. PostgreSQL, Kong, pg-meta,
and the enrolled Fleet Agent join the explicit `fleet-management` network;
every other service remains on the Compose project's private default network.
Project-owned pg-meta needs this network to resolve the registered `db-<ref>`
address while Fleet Studio reaches it through the project's `/pg` gateway route. Use a unique
Compose project name, project ref, container prefix, ports, data volumes and
function/config roots for every managed instance.

The first same-host simulation uses Docker DNS names such as `db-project-a` and
`kong-project-a`. Remote devices use routable TLS/VPN addresses instead; the
project attachment and Agent environment change, but the Studio APIs and trust
protocol do not.

Compose invocation:

```bash
docker compose -p supabase-managed-a \
  --env-file docker/self-platform/.env \
  --env-file docker/fleet-managed/project-a.env \
  -f docker/docker-compose.yml \
  -f docker/fleet-managed/docker-compose.override.yml \
  up -d
```

Generate each instance environment with `scripts/init-instance-env.sh`. The
script copies `PG_META_CRYPTO_KEY` from
`docker/self-platform/control-plane.env` into the project-specific, gitignored
environment so Fleet Studio can send that project's encrypted read-write or
read-only DSN to its own pg-meta. Existing instance env files created before
this change must add the same value before pg-meta is recreated.

Enrollment is a separate, single-use action after Central Studio has created a
project attachment and management binding:

```bash
docker compose -p supabase-managed-a \
  --env-file docker/self-platform/.env \
  --env-file docker/fleet-managed/project-a.env \
  -f docker/docker-compose.yml \
  -f docker/fleet-managed/docker-compose.override.yml \
  --profile enroll run --rm fleet-agent-bootstrap

docker compose -p supabase-managed-a \
  --env-file docker/self-platform/.env \
  --env-file docker/fleet-managed/project-a.env \
  -f docker/docker-compose.yml \
  -f docker/fleet-managed/docker-compose.override.yml \
  --profile agent up -d fleet-agent
```

`capabilities.json` does not advertise `runtime.config.reconcile`. The Agent
can write Fleet-owned configuration revisions, but no managed service consumes
them yet, so advertising the capability would report changes as applied when
they are not. It returns with the runtime-configuration work in the
[Fleet completion roadmap](../../docs/self-hosted-parity/2026-09-28-fleet-completion-roadmap.md).

Do not mount the Docker socket into the generic Fleet Agent. Lifecycle actions
remain unavailable until a versioned, allowlisted provider is installed. Backup
also remains explicitly unconfigured until a target-local Backup Agent and
repository have completed their own recovery acceptance.
