# Platform control-plane mini-stack (M1 login gate, F9+F16)

This is a **local-only, not-upstream** addition. It gives self-hosted Studio its own
lightweight multi-user/multi-org control plane (metadata Postgres + a dedicated GoTrue
instance) instead of Supabase's real hosted platform API, so Studio can run in "self-platform"
mode: real sign-up/sign-in, an org/profile shell, and an authorization gate in front of the
existing self-hosted project — without depending on any external service.

It is **not** a general multi-project platform yet. See "M1 boundary" below.

## What it is

Two services, defined in `docker/docker-compose.platform.yml`, layered on top of the main
stack's compose file:

- **`platform-db`** (`supabase-platform-db`, plain `postgres:17-alpine`) — holds GoTrue's own
  `auth.*` schema plus a hand-rolled `platform.*` schema (`organizations`, `profiles`,
  `organization_members`; see `docker/volumes/platform/migrations/01-schema.sql`). This is
  metadata only — it has nothing to do with the actual project database
  (`supabase-db` / `docker/volumes/db`), which self-hosted Studio still talks to via pg-meta
  exactly as before.
- **`platform-auth`** (`supabase-platform-auth`, `supabase/gotrue:v2.189.0` — same image tag as
  the main stack's auth service) — a dedicated GoTrue instance, not fronted by Kong, that issues
  and validates sessions for Studio's own dashboard users. Autoconfirm is on (no SMTP in M1),
  and signup is open (`GOTRUE_DISABLE_SIGNUP: 'false'`).

Neither service touches the main stack's containers, volumes, or ports.

## Starting it

```bash
cd /Volumes/data/projects/supabase/docker
docker compose -f docker-compose.yml -f docker-compose.platform.yml up -d platform-db platform-auth
```

Check health:

```bash
docker compose -f docker-compose.yml -f docker-compose.platform.yml ps platform-db platform-auth
curl -s http://localhost:8110/health
```

## Required `.env` variables

Set these in `docker/.env` (never commit this file — it holds secrets):

| Variable                     | Required | Notes                                                                                     |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------ |
| `PLATFORM_POSTGRES_PASSWORD` | Yes      | `postgres` role password on `platform-db`. Generate with `openssl rand -hex 16`.          |
| `PLATFORM_JWT_SECRET`        | Yes      | GoTrue JWT signing secret, **>= 32 chars**. Generate with `openssl rand -hex 32`.          |
| `PLATFORM_POSTGRES_HOST_PORT` | No (local override only) | See "Host port overrides" below.                                          |
| `PLATFORM_GOTRUE_HOST_PORT`  | No       | Defaults to `8110`.                                                                        |
| `PLATFORM_SITE_URL`          | No       | Defaults to `http://localhost:8082` (the dev-server port Studio runs on when built from source). Drives `GOTRUE_SITE_URL` / `GOTRUE_URI_ALLOW_LIST`. |
| `PLATFORM_JWT_EXPIRY`        | No       | Defaults to `3600` seconds.                                                                |

### Host port overrides

`docker-compose.platform.yml` parameterizes `platform-db`'s host port as
`${PLATFORM_POSTGRES_HOST_PORT:-5433}` — the **committed default is 5433**. If port 5433 is
already taken on your machine by something unrelated (on this machine it was —
`chatwoot-pg18`, an unrelated pre-existing container, owns 5433), set
`PLATFORM_POSTGRES_HOST_PORT` to a free port in your local `docker/.env` (e.g. `5434`). This is
a **machine-local override only**: it does not change the compose file's committed default, and
it does not affect anything that talks to `platform-db` over the Docker-internal network
(GoTrue, pg-meta) — only direct host-side `psql`/client access needs to know the actual port in
use. Check `docker compose -f docker-compose.yml -f docker-compose.platform.yml ps platform-db`
if unsure which port is live on your machine.

## Studio platform-mode env profile

To run source-built Studio (`pnpm dev:studio`) against this mini-stack instead of plain
self-hosted mode, `apps/studio/.env.local` needs this block (in addition to whatever
self-hosted-only overrides — `STUDIO_PG_META_URL`, `PG_META_CRYPTO_KEY`,
`SNIPPETS_MANAGEMENT_FOLDER` — your machine already has for the main stack; see the comments in
that file):

```bash
NEXT_PUBLIC_IS_PLATFORM=true
NEXT_PUBLIC_SELF_PLATFORM=true
NEXT_PUBLIC_API_URL=http://localhost:8082/api
# Direct to platform-auth — NOT through Kong's /auth/v1 rewrite (platform-auth
# has no gateway in front of it).
NEXT_PUBLIC_GOTRUE_URL=http://localhost:8110
NEXT_PUBLIC_HCAPTCHA_SITE_KEY=10000000-ffff-ffff-ffff-000000000001
PLATFORM_GOTRUE_URL=http://localhost:8110
PLATFORM_POSTGRES_HOST=platform-db
PLATFORM_POSTGRES_PORT=5432
PLATFORM_POSTGRES_DB=platform
PLATFORM_POSTGRES_USER=postgres
PLATFORM_POSTGRES_PASSWORD=<value must exactly match PLATFORM_POSTGRES_PASSWORD in docker/.env>
PLATFORM_PG_META_URL=http://localhost:8100/pg
```

Notes on two easy-to-miss entries:

- **`PLATFORM_POSTGRES_PASSWORD` must be byte-identical to `docker/.env`'s value.** It is used
  server-side by `lib/api/self-platform/db.ts` to build the encrypted connection Studio uses to
  query `platform-db` directly (profiles, organizations, membership). A mismatch fails
  authentication and `/api/platform/profile` / `/api/platform/organizations` 500.
- **`PLATFORM_PG_META_URL` is required and easy to forget** — it is *not* one of the
  `PLATFORM_POSTGRES_*` variables above, and nothing in the platform-db/platform-auth stack
  needs it directly. It exists because `lib/constants/index.ts` resolves `PG_META_URL` (the URL
  Studio uses to talk to pg-meta for the actual *project* database — Table Editor, SQL Editor,
  Database pages) by branching on `IS_PLATFORM`: self-hosted mode uses `STUDIO_PG_META_URL`,
  platform mode uses `PLATFORM_PG_META_URL` instead. There is no separate platform-only pg-meta
  service — `docker-compose.platform.yml` only stands up `platform-db` + `platform-auth` — so
  this should point at the **same** pg-meta target as `STUDIO_PG_META_URL`
  (`http://localhost:8100/pg` via Kong on this machine). Leaving it unset makes `PG_META_URL`
  resolve to `undefined` and every self-platform DB-backed route (Table Editor, SQL Editor,
  Database, project connection info) 500s. (Discovered during Task 11's live re-verification,
  required as of Task 12's committed env profile — see
  `docs/self-hosted-parity/2026-07-02-M1-spike-findings.md` and
  `.superpowers/sdd/task-11-report.md`'s "Interstitial Fix Report".)

To switch back to plain self-hosted mode for regression testing, swap in a self-hosted-profile
backup of `.env.local` (e.g. `apps/studio/.env.local.selfhosted.bak`) and restart the dev
server — no code changes needed either direction, only the env profile.

## First admin registration

1. Start both stacks: the main self-hosted stack (`docker compose up -d`, Kong on `:8100`) and
   this platform mini-stack (above), plus `pnpm dev:studio` (Studio dev server, `:8082`) with
   the platform env profile in place.
2. Visit `http://localhost:8082/sign-up` and register with any email/password — GoTrue
   autoconfirms (no SMTP configured in M1), so the account is immediately usable, no email step.
3. On first login, Studio auto-provisions a `platform.profiles` row for the new GoTrue user and
   adds them as a member of the seeded `Default Organization` (`platform.organizations`, slug
   `default`) — there is only one organization and one project in M1 (see boundary below), so
   every registered user lands with full access to it. No invite flow, no role selection.
4. Verify directly against `platform-db` if needed:
   ```bash
   docker exec supabase-platform-db psql -U postgres -d platform \
     -c "select username, primary_email from platform.profiles;" \
     -c "select * from platform.organization_members;"
   ```

## M1 boundary

M1 intentionally implements the smallest slice that makes self-platform mode a real login gate
in front of the existing single self-hosted project, not a general multi-tenant platform:

- **Single project.** There is exactly one project (`default`, the existing self-hosted
  project/database) — no project creation, no per-user project isolation.
- **Full permissions.** Every authenticated, org-member user has full access to that project
  (Table Editor, SQL Editor, Database, Auth, Storage, Logs, etc.) — no role-based access control
  or per-resource permission scoping.
- **Registration is open.** `GOTRUE_DISABLE_SIGNUP: 'false'` — anyone who can reach `:8082` can
  self-register and get full access to the one project. Tightening this (invite-only signup,
  roles, project isolation) is explicitly deferred to M3.

## Known limitations (M1)

- **Service-health endpoints always report healthy.** `/api/v1/projects/{ref}/health` and
  `/api/platform/projects/{ref}/databases-statuses` are contract-minimal stubs that echo back
  `ACTIVE_HEALTHY`/`healthy: true` unconditionally — there is no real probing of the underlying
  Postgres/pg-meta/storage/etc. processes. A genuinely unhealthy project still reports healthy
  in the UI.
- **Several `/api/platform/*` and `/api/v1/*` routes are contract-minimal stubs, not real
  implementations.** Notifications, telemetry feature flags, Stripe overdue invoices,
  entitlements, usage, OAuth apps, resource warnings, network bans, branches, backups, load
  balancers, and upgrade status all return the minimal legally-typed "nothing to report" value
  (empty arrays/objects, `false`/`null` flags) rather than real data — there is no billing,
  branching, backups, or load-balancer management in M1. See
  `.superpowers/sdd/task-11-report.md`'s stub table for the full list and per-route rationale.
- **No real email.** Signup autoconfirms; there is no password-reset-via-email flow either
  (no SMTP configured).
- **Auth settings and Storage settings config endpoints are unimplemented** (`/platform/auth/
  {ref}/config`, `/platform/projects/{ref}/config/storage`) — only reachable today via a stray
  sidebar-hover prefetch, not by visiting those settings pages, which are out of M1 scope.
