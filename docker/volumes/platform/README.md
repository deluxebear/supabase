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
  and validates sessions for Studio's own dashboard users. Autoconfirm was on and signup was open
  (`GOTRUE_DISABLE_SIGNUP: 'false'`) in M1, with no SMTP configured. This has since changed: as of
  M3.2, `platform-mail` (Mailpit) provides real outbound email and signup is invite-only
  (`GOTRUE_DISABLE_SIGNUP: 'true'`) — see "M3.2: Invitations, SMTP, invite-only signup, and MFA
  enforcement" below.

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
  server-side by `lib/api/self-platform/db.ts` to build the connection string Studio uses to query
  `platform-db` (profiles, organizations, membership). A mismatch fails authentication and
  `/api/platform/profile` / `/api/platform/organizations` 500.
  **Note (ledger #12):** `PLATFORM_POSTGRES_HOST` (and the rest of `PLATFORM_POSTGRES_*`) is
  consumed to build that connection string, but Studio never opens a raw Postgres socket to it
  itself — the string is AES-encrypted and handed to pg-meta's `/query` endpoint via the
  `x-connection-encrypted` header (the same proxy mechanism `lib/api/self-hosted/query.ts` uses
  for the real *project* database); pg-meta is what actually dials Postgres.
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

**As of M3.2, public self-registration is disabled** (`GOTRUE_DISABLE_SIGNUP: 'true'`) — the
original M1 flow of visiting `/sign-up` and registering with any email/password no longer works
(`pages/api/platform/signup.ts` now unconditionally `403`s). To create the very first dashboard
user today, follow "Bootstrapping the first admin" (under "M3.2: Invitations, SMTP, invite-only
signup, and MFA enforcement" below), which uses the GoTrue admin API directly plus a one-time
`psql` Owner grant. Every subsequent user after that first one is added via the M3.2 invitation
flow (see the M3.2 section), not self-registration.

1. Start both stacks: the main self-hosted stack (`docker compose up -d`, Kong on `:8100`) and
   this platform mini-stack (above), plus `pnpm dev:studio` (Studio dev server, `:8082`) with
   the platform env profile in place.
2. Bootstrap the first admin — see "Bootstrapping the first admin" below.
3. On first login, Studio auto-provisions a `platform.profiles` row for the new GoTrue user and
   adds them as a member of the seeded `Default Organization` (`platform.organizations`, slug
   `default`) — there is only one organization and one project in M1 (see boundary below), so
   every registered user lands with full access to it, subject to the role/MFA gates added in
   M3.0/M3.1/M3.2 (see those sections below).
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
- **Registration was open in M1.** `GOTRUE_DISABLE_SIGNUP: 'false'` — anyone who could reach
  `:8082` could self-register and get full access to the one project. This has since been
  tightened: project isolation shipped in M2, role-based access control in M3.0/M3.1, and
  invite-only signup (`GOTRUE_DISABLE_SIGNUP: 'true'`, no more open self-registration) in M3.2 —
  see "M3.2: Invitations, SMTP, invite-only signup, and MFA enforcement" below.

## Known limitations (M1)

- **Service-health endpoints always report healthy.** `/api/v1/projects/{ref}/health` and
  `/api/platform/projects/{ref}/databases-statuses` are contract-minimal stubs that echo back
  `ACTIVE_HEALTHY`/`healthy: true` unconditionally — there is no real probing of the underlying
  Postgres/pg-meta/storage/etc. processes. A genuinely unhealthy project still reports healthy
  in the UI. Superseded in M6.0: both routes now probe the stack for real in self-platform mode — see the M6.0 section below. (Plain self-hosted keeps the static stub.)
- **Several `/api/platform/*` and `/api/v1/*` routes are contract-minimal stubs, not real
  implementations.** Notifications, telemetry feature flags, Stripe overdue invoices,
  entitlements, usage, OAuth apps, resource warnings, network bans, branches, backups, load
  balancers, and upgrade status all return the minimal legally-typed "nothing to report" value
  (empty arrays/objects, `false`/`null` flags) rather than real data — there is no billing,
  branching, backups, or load-balancer management in M1. See
  `.superpowers/sdd/task-11-report.md`'s stub table for the full list and per-route rationale.
- **No real email (M1).** Signup autoconfirmed; there was no password-reset-via-email flow
  either (no SMTP configured). This has since changed: `platform-mail` (Mailpit) SMTP and
  outbound invitation email shipped in M3.2 — see "M3.2: Invitations, SMTP, invite-only signup,
  and MFA enforcement" below.
- **Auth settings and Storage settings config endpoints are unimplemented** (`/platform/auth/
  {ref}/config`, `/platform/projects/{ref}/config/storage`) — only reachable today via a stray
  sidebar-hover prefetch, not by visiting those settings pages, which are out of M1 scope.

## M2: multi-project registry

M1 hardcoded a single project (`default`, resolved from global `docker/.env`-sourced process
env). M2 adds `platform.projects`, a real registry table that lets self-platform mode host
**multiple** independently-connected Supabase stacks (or, as a lighter-weight substitute, multiple
databases behind one stack — see below) side by side, each addressed by its own `ref`, with
Studio's core data-plane routes resolving the right connection per request instead of always
falling back to the single global-env project.

### `platform.projects` table

Defined in `docker/volumes/platform/migrations/02-projects.sql` (loaded into `platform-db`
alongside the M1 `platform.*` schema). One row per registered project:

| Column                                  | Purpose                                                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| `ref` (unique)                          | The project ref used in URLs/API paths (`/project/{ref}`, `/api/platform/pg-meta/{ref}/query`, ...). |
| `organization_id`                       | FK to `platform.organizations` — which org's project list this shows up in.             |
| `name`, `status`, `cloud_provider`, `region` | Display metadata, contract-shaped to match the real hosted API's project object.     |
| `db_host`, `db_port`, `db_name`, `db_user`, `db_user_readonly` | Connection coordinates, in plaintext. `db_host` **must** be a hostname reachable from the pg-meta container's Docker network (e.g. `db`), never `localhost`/`127.0.0.1` (that only resolves to the host running the CLI). |
| `kong_url`, `rest_url`                  | The project's browser-facing gateway/REST URLs.                                         |
| `db_pass_enc`, `service_key_enc`, `anon_key_enc`, `jwt_secret_enc`, `publishable_key_enc`, `secret_key_enc` | AES-encrypted secrets (see below) — never stored in plaintext. |

`apps/studio/lib/api/self-platform/resolve-connection.ts`'s `resolveProjectConnection(ref)` is
the single entry point every registry-aware route calls: registry hit -> decrypt secrets, build a
DSN, re-encrypt with pg-meta's transport key; `ref === 'default'` with **no** registry row ->
fall back to the M1 global-env project (zero-break, see "M2 boundary" below); any other unknown
ref -> throws `ProjectNotFound`, which routes map to `404 {"message":"Project not found"}`.

### Upgrading an existing M1 platform-db

`docker/volumes/platform/migrations/02-projects.sql` only runs automatically against an **empty**
`platform-db` data directory (that's how the base `postgres:17-alpine` image's
`/docker-entrypoint-initdb.d` init mechanism works — it only fires on first init). If you already
have an M1 deployment running (a `platform-db` volume created before M2 shipped) and pull forward
to M2, that volume's data directory is *not* empty, so `02-projects.sql` never runs and
`platform.projects` never gets created. Every `resolveProjectConnection` call then throws
`relation "platform.projects" does not exist` (`resolveProjectConnection` treats this as a
registry miss — `ref='default'` still falls back to the global-env project, but this is a
defensive fallback, not a substitute for actually running the migration; any non-default ref still
404s until the table exists and is populated).

Apply the migration by hand once, against the running `platform-db` container:

```bash
docker exec -i supabase-platform-db psql -U postgres -d platform < docker/volumes/platform/migrations/02-projects.sql
```

Note this is a plain `create table` (no `if not exists`), so only run it once per data
directory — re-running it after it has already succeeded fails with `relation "platform.projects"
already exists`, which is harmless (the table is already there) but not silently idempotent. After
applying it, register the existing project as `ref=default` with
`register-project.ts --from-current-env` (see below) if you want it to show up as a real registry
row instead of relying on the global-env fallback.

### `PLATFORM_ENCRYPTION_KEY` — required, back it up

Registry secret columns (`*_enc`) are AES-encrypted (via `crypto-js`, same library/pattern as the
GoTrue metadata columns) with `PLATFORM_ENCRYPTION_KEY`. This key is required in **two places**,
independently, because two different processes need it:

1. **`docker/.env`** — read by `register-project.ts` (the CLI below) when it encrypts secrets on
   `register`/`--from-current-env`, and when it would need to decrypt for any future CLI read
   path. Generate with `openssl rand -hex 32` (or similar); never commit `docker/.env`.
2. **`apps/studio/.env.local`** (source-built dev server) or the Studio container's env (Docker
   deployment) — read by `apps/studio/lib/api/self-platform/secrets.ts` at request time to
   *decrypt* the columns `resolveProjectConnection` just read. **Must be byte-identical to
   `docker/.env`'s value.** A mismatch (or a value present in one place but not the other) fails
   closed: every registry-backed route 500s with `Error: PLATFORM_ENCRYPTION_KEY is not set` (if
   unset) or a decrypt failure (if mismatched) — this is not a soft-degrade, secrets simply cannot
   be read. Discovered live during M2 Task 10 acceptance: the CLI worked fine (its shell had the
   key exported from `docker/.env`), but the dev server 500'd on every per-project SQL query until
   the same key was added to `apps/studio/.env.local` too — see that file's inline comment.

**Losing this key is unrecoverable for the registry.** There is no key-rotation or re-encryption
tooling. If `PLATFORM_ENCRYPTION_KEY` is lost (and not recoverable from a backup of `docker/.env`),
every secret column in `platform.projects` (db passwords, service/anon/JWT keys for every
registered project) becomes permanently undecryptable — the only recovery path is
`deregister`-then-`register` every project again with fresh credentials. **Back up `docker/.env`
somewhere durable outside the repo** (it's gitignored and never committed) before registering any
project you don't want to have to re-enter by hand.

### `register-project` CLI

`docker/scripts/platform/register-project.ts`, run via `pnpm exec tsx`. Talks to `platform-db`
through `docker exec -i supabase-platform-db psql` (no new DB-client dependency added). Always
export `PLATFORM_ENCRYPTION_KEY` first (register/deregister need it to encrypt; a missing key
fails closed with `PLATFORM_ENCRYPTION_KEY is not set`, never silently writes plaintext):

```bash
cd /Volumes/data/projects/supabase
export PLATFORM_ENCRYPTION_KEY=$(grep -E '^PLATFORM_ENCRYPTION_KEY=' docker/.env | cut -d= -f2)
```

**`register --from-current-env`** — registers/updates a project by reading the *current shell's*
env for the real `docker/.env` variable names (`POSTGRES_HOST`, `POSTGRES_PASSWORD`, `ANON_KEY`,
`SERVICE_ROLE_KEY`, `JWT_SECRET`, `SUPABASE_URL`/`SUPABASE_PUBLIC_URL`, ...) — this is how you
register the existing main stack as `ref=default`. The shell must actually have those variables
exported first; sourcing `docker/.env` directly with `set -a; . docker/.env; set +a` works, but
note some unrelated lines in `docker/.env` (e.g. `STUDIO_DEFAULT_ORGANIZATION=Default Organization`,
unquoted values containing spaces) will emit harmless "command not found" warnings from the shell
when sourced this way — they don't affect the variables the CLI actually reads, and the
registration still succeeds:

```bash
set -a; . docker/.env; set +a
pnpm exec tsx docker/scripts/platform/register-project.ts register --from-current-env --ref default --org default
```

**`--from-current-env` also auto-picks-up `LOGFLARE_URL`/`LOGFLARE_PRIVATE_ACCESS_TOKEN`** (M2.1)
— if those are present in the environment when `--from-current-env` runs, they populate
`logflare_url`/`logflare_token_enc` on the same upsert; see "Analytics (M2.1)" below for the
env-injection invocation this repo actually used, since `docker/.env` doesn't define
`LOGFLARE_URL` by default (no Logflare container deployed on this machine).

**`register` with explicit flags** — for any project that isn't "the current `docker/.env`
stack", e.g. a second project. Required flags: `--ref --org --name --db-host --kong-url --db-pass
--service-key --anon-key --jwt-secret`; optional: `--db-port` (default `5432`), `--db-name`
(default `postgres`), `--db-user` (default `supabase_admin`), `--db-user-readonly`, `--rest-url`
(default `<kong-url>/rest/v1/`), `--publishable-key`, `--secret-key`, `--logflare-url`,
`--logflare-token` (M2.1 — see "Analytics (M2.1)" below). Both branches (`register` and
`--from-current-env`) are guarded against silently registering empty-secret projects — missing
required fields fail with `missing required field(s): ...` rather than exiting 0:

```bash
pnpm exec tsx docker/scripts/platform/register-project.ts register \
  --ref proj-b --org default --name "Project B" \
  --db-host db --db-port 5432 --db-name projectb \
  --kong-url http://localhost:8100 \
  --db-pass "$POSTGRES_PASSWORD" --service-key "$SERVICE_ROLE_KEY" \
  --anon-key "$ANON_KEY" --jwt-secret "$JWT_SECRET"
```

**`deregister --ref <ref>`** — deletes the row. `ref=default` deregistering does **not** break
anything: `resolveProjectConnection('default')` falls back to the M1 global-env project the moment
the registry row is gone (verified live, see the M2 acceptance record).

**`list`** — prints `ref, organization_id, name, status, db_host` for every registered project.
No pagination (see "known limitations" below — this is the admin CLI, separate from the
paginated `/api/platform/projects` route).

### Registering a second project without a second stack

A full second `docker compose` stack (different project name/ports/volumes) is the "real" way to
get a second project, but for local verification a lighter substitute works and is enough to prove
real isolation: create a **second database on the same Postgres server** and register it with the
same `kong_url`/keys but a different `db_name`:

```bash
docker exec supabase-db psql -U postgres -c "create database projectb;"
docker exec supabase-db psql -U postgres -d projectb -c "create table only_in_b (id serial primary key, note text);"
```

then `register --ref proj-b ... --db-name projectb` (same `db-host`/`kong-url`/keys as `default`).
Because `resolveProjectConnection` builds a full `postgresql://user:pass@host:port/dbname` DSN per
row, switching project refs in Studio genuinely reconnects to a different database on the same
server — `select current_database()` returns a different value per ref, and a table that only
exists in one database (like `only_in_b` above) is queryable under that ref and fails with
`relation "only_in_b" does not exist` under any other ref. This is real Postgres-level isolation
(different `pg_database`, no data path crosses over), just not a full second Kong/GoTrue/pg-meta
stack — API keys and the gateway URL are shared across projects registered this way, since they
all point at the one running stack's Kong. A full second stack would additionally isolate those.

### M2 boundary

M2 makes the **core data plane** — the routes a day-to-day dashboard session actually depends on
— resolve per `ref` from the registry instead of always reading global env:

- Seed/bootstrap routes (`pages/api/platform/projects/[ref]/index.ts` and `.../databases.ts`) —
  note `.../billing/addons.ts` at the same path level is a separate, still-static stub (always
  `{ selected_addons: [], available_addons: [] }`), not registry-aware
- Project settings (`pages/api/platform/projects/[ref]/settings.ts`) and API keys
  (`pages/api/v1/projects/[ref]/api-keys*`)
- SQL query execution (`pages/api/platform/pg-meta/[ref]/query/index.ts` via
  `executeQuery({ projectRef })`) — this is what both the SQL Editor and (transitively) Table
  Editor's query-shaped operations use
- Project list endpoints (`/api/platform/projects` with the `Version: 2` header,
  `/api/platform/organizations/{slug}/projects`) — both now enumerate every registered project,
  not a hardcoded single entry

**Fixed in M2.1 — resolved per-ref.** As of M2.1 (see "M2.1: per-ref hardening" below), all of the
following `[ref]` route families resolve their target from the registry per `ref` — via
`resolveProjectConnection`, the `getAdminContextForRef`/`getAdminClientForRef` admin-client
factory, or `getAnalyticsTarget`, the same pattern SQL Editor established in M2 — instead of
silently falling back to the single global-env project:

- **Auth admin**: invite, magic-link, OTP, password-recovery, user list/get, MFA factors
  (`pages/api/platform/auth/[ref]/{invite,magiclink,otp,recover}.ts`,
  `.../auth/[ref]/users*`).
- **Storage**: buckets, objects (upload/download/list/move/sign/public-url), vector buckets and
  their indexes (14 routes under `pages/api/platform/storage/[ref]/`).
- **Analytics/Logs**: Logflare query endpoints and log drains (see "Analytics (M2.1)" below).
- **Props**: project API-key surface (`pages/api/platform/props/project/[ref]/api.ts`) and its
  index.
- **Lints and migrations**: `lib/api/self-hosted/{lints,migrations}.ts` and their routes
  (`projects/[ref]/run-lints.ts`, `v1/projects/[ref]/database/migrations.ts`).

Practically: switching to a non-default registered project now shows *that* project's own
auth users, storage buckets, and logs — not the default project's.

**Still global, not yet per-project (post-M2.1 gap):**

- `pages/api/platform/auth/[ref]/config` — GoTrue admin *settings* specifically (separate from the
  now-per-ref invite/otp/magiclink/recover/users routes above). This sub-route was never
  implemented in M1 (see "Known limitations (M1)") and is still global-shaped if built out later.
- Realtime, Edge Functions.
- Any pg-meta sub-resource route beyond `query`/lints/migrations (`tables`, `views`, `extensions`,
  etc.) — only those three were threaded with `projectRef`.
- `pages/api/mcp/index.ts` — confirmed untouched as of M2.1; see "MCP per-ref asymmetry" under
  "M2.2: credential closure" below for the per-operation breakdown as of M2.2 (`getLogs` is
  transitively per-ref, `getSecurityAdvisors`/`getPerformanceAdvisors` are not).

These still return the **default** project's data/keys regardless of the selected project's `ref`.

**Fixed in M2.2 — resolved per-ref.** `pages/api/platform/projects/[ref]/config/index.ts` and
`.../config/postgrest.ts` (project config, including `jwt_secret`) and
`pages/api/platform/projects/[ref]/api/rest.ts` and `.../api/graphql.ts` (PostgREST/pg-graphql
proxy surfaces) now resolve the target project via `resolveProjectConnection` per `ref`, with the
same `conn.row` zero-break gate and `ProjectNotFound` -> 404 skeleton as every other per-ref route.
See "M2.2: credential closure" below for details.

**Credential-bearing gaps — fixed in M2.1 and M2.2.** Most of the still-global routes above leak
the *wrong project's rows* (bad, but data-scoped). A subset return **global credentials for any
`ref`** instead — these were the top M2.1/M2.2 priority, and all of them are now fixed:

- ~~`pages/api/platform/projects/[ref]/api-keys/temporary.ts`~~ — **fixed in M2.1** (see
  "Short-lived per-project JWTs" — it now mints a per-project-scoped, 5-minute JWT instead of
  returning the global `SUPABASE_SERVICE_KEY` verbatim).
- ~~`pages/api/platform/props/project/[ref]/api.ts`~~ — **fixed in M2.1**: returns the resolved
  connection's own anon/service keys per `ref` instead of the global ones.
- ~~`pages/api/platform/projects/[ref]/config/index.ts` and `.../config/postgrest.ts`~~ — **fixed
  in M2.2**: `jwt_secret` now comes from the resolved project per `ref` (see "M2.2: credential
  closure" below).
- ~~`pages/api/platform/projects/[ref]/api/rest.ts` and `.../api/graphql.ts`~~ — **fixed in
  M2.2**: the PostgREST/pg-graphql proxy now targets the resolved project's own URL and
  anon/service key per `ref` instead of the global ones.
- `pages/api/platform/auth/[ref]/config` — still not credential-bearing today because it's
  **unimplemented**, not because it was hardened (see above); if it's ever built out, it needs the
  same per-ref treatment as every route above.

As of M2.2, there are **no remaining known credential-bearing routes that ignore `ref`** — the
`auth/[ref]/config` line above is the one open item, and it's open because the route doesn't exist
yet, not because it leaks. If new credential-bearing routes are added later, the invariant every
fixed route above now follows is: resolve via `resolveProjectConnection` (or the equivalent
admin-client/analytics-target factory) before touching any secret, and 404 via `ProjectNotFound`
for unknown refs rather than silently falling through to the global project.

### Short-lived per-project JWTs

`pages/api/platform/projects/[ref]/api-keys/temporary.ts` (consumed by the Realtime Inspector and
Storage Explorer) resolves the project's own JWT secret per `ref` and mints a short-lived HS256
JWT (`exp - iat = 300` seconds) instead of returning a raw, long-lived service-role key. Plain
self-hosted mode (`IS_SELF_PLATFORM` false) is unchanged — it still returns the global
`SUPABASE_SERVICE_KEY` verbatim, matching pre-M2.1 behavior byte-for-byte.

**Also not project-scoped (pre-existing, unrelated to the registry):** SQL Editor's saved
snippets (`SNIPPETS_MANAGEMENT_FOLDER`, on-disk) are a single shared folder read by every project
— the same snippet list appears in every registered project's SQL Editor sidebar. Query
*execution* is correctly routed per-project (see above); the snippet *list/metadata* is not.

### Known limitations (M2)

- ~~Pagination is not yet sliced.~~ **Fixed in M2.1** (Task 11): `listAllProjectsV2` and the
  org-projects route now apply real `LIMIT`/`OFFSET` (plus `COUNT(*)`) at the SQL level via
  `listAllProjects`/`listProjectsByOrgId` in `lib/api/self-platform/projects.ts` — the
  `pagination` envelope reflects an actually-sliced result, not just echoed-back params.
- **No re-encryption/key-rotation tooling** for `PLATFORM_ENCRYPTION_KEY` (see above).
- **The CLI has no `update`-only or `rotate-secret` command** — re-running `register` with the
  same `--ref` upserts (all columns overwritten), which is fine for re-registering but has no
  narrower "just change one field" affordance. Superseded in M6.1: connection details, secrets,
  and Logflare settings are editable from Studio (Settings → General → Connection configuration)
  or via `PATCH /api/platform/projects/{ref}`; the CLI itself still has no update command.

## M2.1: per-ref hardening

M2 left several `[ref]` route families — including two that surfaced credentials, not just data —
still reading the single global-env project regardless of the selected registry row. M2.1 closes
those gaps (see the updated "M2 boundary" section above for the full before/after route list) and
adds one capability the registry didn't have in M2 at all: per-project Logs/Analytics.

### Analytics (M2.1)

`platform.projects` gained two nullable columns via
`docker/volumes/platform/migrations/03-analytics.sql`:

| Column | Purpose |
| --- | --- |
| `logflare_url` | The project's Logflare **base** URL — no `/api/` suffix. Code appends `/api/endpoints/query/{name}` itself (see `getAnalyticsTarget` in `apps/studio/lib/api/self-hosted/logs.ts`). |
| `logflare_token_enc` | AES-encrypted (same `PLATFORM_ENCRYPTION_KEY` scheme as every other `*_enc` column) Logflare private access token. |

**NULL in either column means analytics is not configured for that project.** Studio's Logs routes
(`pages/api/platform/projects/[ref]/analytics/*`, including log drains) then return `404
{"message":"Analytics is not configured for this project"}` — they **never** fall back to the
global stack's `LOGFLARE_URL`/`LOGFLARE_PRIVATE_ACCESS_TOKEN`, even if those env vars happen to be
set for the Studio process. This is a hard invariant enforced per-route via the
`AnalyticsNotConfigured` error type, not a soft default.

**The `?project=default` assumption.** When Studio queries a registered project's Logflare, it
always sets the outbound `?project=` query param to the literal string `default`
(`AnalyticsTarget.projectParam`), never the registry's own `ref`. This is deliberate: a registered
per-project analytics backend is assumed to be a **vanilla self-hosted stack**, and every vanilla
self-hosted Logflare instance self-identifies its own (only) project as `default` internally,
regardless of whatever ref/name Studio's registry gave it. If a future registered project's
Logflare is ever *not* a vanilla single-project self-hosted stack, this assumption needs
revisiting.

**Applying the migration** (mirrors Task 2's live verification command — safe to re-run, uses
`add column if not exists`):

```bash
docker exec -i supabase-platform-db psql -U postgres -d platform -v ON_ERROR_STOP=1 \
  < docker/volumes/platform/migrations/03-analytics.sql
```

**This environment has no Logflare container deployed** — `docker/.env` does not define
`LOGFLARE_URL` by default (analytics is an opt-in docker-compose add-on, not part of the base
stack). The documented backfill path is **env-injection at CLI invocation time**, not a
`docker/.env` edit:

```bash
LOGFLARE_URL=http://localhost:4000 \
  pnpm exec tsx docker/scripts/platform/register-project.ts register --from-current-env --ref default --org default
```

(`docker/.env` is still sourced first per the usual `--from-current-env` flow — see the CLI
section above — this just adds `LOGFLARE_URL` to the shell for this one invocation.) The
`on conflict (ref)` upsert means re-running this is always safe. This has already been run for the
`default` row on this machine (Task 3).

### Upgrading an existing M2 platform-db to M2.1

If you already applied M2's `02-projects.sql` and registered projects before M2.1 shipped:

1. Apply `03-analytics.sql` (above). Existing rows get `NULL` for both new columns — expected, not
   an error.
2. **Before** the migration is applied at all, the registry read code degrades gracefully instead
   of crashing: `apps/studio/lib/api/self-platform/projects.ts` detects the missing-column error,
   retries with a legacy column list, and logs
   `[self-platform] platform.projects has no analytics columns (pre-M2.1 platform-db) — treating
   logflare_url/logflare_token_enc as NULL. Run docker/volumes/platform/migrations/03-analytics.sql
   to upgrade.` — analytics is simply treated as not-configured (404s) until you migrate.
3. Backfill `logflare_url`/`logflare_token_enc` for existing rows one of two ways:
   - **Re-run `register --from-current-env`** (or `register` with explicit flags) for that ref —
     the upsert overwrites *all* columns, so re-supply every flag/env var you originally used, not
     just the Logflare ones. See the env-injection invocation above for `default`.
   - **Hand-write just the two columns** if you don't want a full re-register. Generate the token
     ciphertext with the CLI's own `encryptSecret` helper:
     ```bash
     export PLATFORM_ENCRYPTION_KEY=$(grep -E '^PLATFORM_ENCRYPTION_KEY=' docker/.env | cut -d= -f2)
     pnpm exec tsx -e "
       import('./docker/scripts/platform/register-project.ts').then(({ encryptSecret }) =>
         console.log(encryptSecret('<your-logflare-private-access-token>'))
       )"
     ```
     then apply it directly:
     ```bash
     docker exec -i supabase-platform-db psql -U postgres -d platform -c \
       "update platform.projects set logflare_url = 'http://localhost:4000', logflare_token_enc = '<ciphertext from above>' where ref = 'default';"
     ```

## M2.2: credential closure

M2.1 closed the two credential-bearing gaps that mint or return secrets outright (temporary JWTs,
the props API-key surface) but left four routes still reading the global-env project regardless of
`ref`: the two project-config routes (`config/index.ts`, `config/postgrest.ts`, both of which
return `jwt_secret`) and the two data-plane proxy routes (`api/rest.ts`, `api/graphql.ts`, both of
which forward a service-role `apikey`). M2.2 closes those, using the same pattern the M2/M2.1
routes already established.

### Fixed in M2.2

- `pages/api/platform/projects/[ref]/config/index.ts` and `.../config/postgrest.ts` — `jwt_secret`
  is now resolved via `resolveProjectConnection(ref)` when `IS_SELF_PLATFORM` is set and the
  registry has a row for that `ref`; the other PostgREST-shaped fields (`db_schema`, `max_rows`,
  etc.) are stack-level config the registry doesn't model, so they keep their historical
  env-sourced values. `ref='default'` with no registry row falls back to the global-env
  `jwt_secret` byte-for-byte (zero-break); any other unknown `ref` -> `404 {"message": "Project
  not found"}`. Plain self-hosted mode (`IS_SELF_PLATFORM` false) is unchanged.
- `pages/api/platform/projects/[ref]/api/rest.ts` and `.../api/graphql.ts` — both now resolve the
  target project's own Supabase URL and anon/service key via `resolveProjectConnection(ref)`
  before proxying the request (GET for rest, POST for graphql), instead of always proxying to the
  global-env project with the global service key. Same `conn.row` zero-break gate and
  `ProjectNotFound` -> 404 skeleton as every other per-ref route in this stack; ghost refs never
  reach the outbound `fetch()` call.

With this, every route identified across M2/M2.1/M2.2 that returns a credential (JWT secret,
service key, anon key) resolves that credential per registered `ref` rather than from global
process env. See "Credential-bearing gaps — fixed in M2.1 and M2.2" above for the consolidated
list and the current "no known remaining gaps" status.

### Shared-stack JWT secret

Projects registered against the **same** underlying stack (see "Registering a second project
without a second stack" above) share that stack's JWT secret. `register-project.ts` takes a
`--jwt-secret` value per row, but the worked example above (and most realistic single-stack
setups) registers every project on one stack with the *same* `--jwt-secret`, because there is only
one Kong/GoTrue/PostgREST instance and it only trusts one signing key. The practical consequence:
a JWT that validates for one `ref` — including a short-lived `temporary` JWT minted for it (see
"Short-lived per-project JWTs") or the `jwt_secret` value returned by `config/index`/
`config/postgrest` for it — is cryptographically valid for its sibling projects on that same stack
too. This is not a bug in the M2.2 per-ref fixes above: per-`ref` resolution correctly returns
*that project's own* configured secret, it's just that the secret happens to be identical across
siblings because they share one instance that only knows one signing key. A genuinely isolated
secret per project requires a genuinely separate stack (its own GoTrue/PostgREST processes, each
configured with its own `JWT_SECRET`) — the "second database, same stack" substitute documented
above proves connection-level isolation but not JWT-level isolation. **This is the boundary M3's
RBAC work needs to design against**: role/claim checks that assume a `ref`-scoped JWT is only
usable against that one `ref` do not hold under shared-stack registration.

### MCP per-ref asymmetry

In self-platform mode, `pages/api/mcp/index.ts` (consuming `lib/api/self-hosted/mcp.ts` — **not**
`pages/api/platform/mcp.ts`, which does not exist; an earlier draft of the M2.1 README cited that
wrong path and it was corrected during M2.1's review, see `.superpowers/sdd/progress.md`'s Task 12
entry) is only partially per-ref today:

- `getDebuggingOperations().getLogs` **is** per-ref, transitively — it calls
  `retrieveAnalyticsData({ name: 'logs.all', projectRef, ... })`, the same per-project Logflare
  resolution `getAnalyticsTarget` established for the Logs UI in M2.1.
- `getSecurityAdvisors` and `getPerformanceAdvisors` are **not** per-ref — both receive a
  `projectRef` parameter but ignore it (`_projectRef`) and call
  `getLints({ headers, exposedSchemas })`, which always queries the single global-env project's
  database, regardless of which project the MCP session is conceptually scoped to.
- `getDevelopmentOperations().getProjectUrl` and `.getPublishableKeys` are also **not** per-ref
  (M2.2-triage finding, carried forward rather than fixed): both take a `projectRef` parameter,
  ignore it (`_projectRef`), and read the single global-env project's URL/publishable key instead.
  Left as-is deliberately — these are doc-only, client-side-safe values (a publishable/anon key and
  a public project URL, never a secret), unlike the credential-bearing routes M2.1/M2.2 closed
  above, so this is the same data-scoped-not-secret-bearing category as the advisors/lints gap.

Threading `projectRef` through the advisors/lints path is deferred: `pages/api/mcp/index.ts`
currently constructs one `createSupabaseMcpServer` per request scoped to a single
`projectId: DEFAULT_PROJECT.ref`, so the MCP server itself isn't multi-project-aware yet — fixing
`getLints`'s global-DB read in isolation wouldn't make MCP usable end-to-end against a non-default
registered project. This is tracked as follow-up work for whenever MCP is made multi-project, not
a credential leak (lints/advisors results are data-scoped, not secret-bearing).

## M3.0: Roles and RBAC

M1/M2/M2.1/M2.2 answered *which project* a request may reach; they had no concept of *what a given
dashboard member is allowed to do* once a project is reachable — every registered member behaved
like the sole M1 admin. M3.0 adds a real role model, seeded and enforced server-side, so a
dashboard session's permissions are looked up per member rather than assumed.

### Role tables and seeding

`docker/volumes/platform/migrations/04-roles.sql` adds three tables: `platform.roles` (one row per
role, `base_role_id` self-references for the four base roles and points at the base for a
project-scoped derived role), `platform.role_projects` (which projects a derived role is scoped
to — empty/absent for an org-wide role), and `platform.member_roles` (which roles a
`platform.profiles` row holds). The four base roles are seeded with **fixed** ids for the default
organization, matched by the client-side `FIXED_ROLE_ORDER`
(`apps/studio/data/organization-members/organization-roles-query.ts`) and the server-side
`BASE_ROLE_ORDER`/`ROLE_MATRIX` (`apps/studio/lib/api/self-platform/rbac/matrix.ts`):

| id  | Name            | Grants                                                                 |
| --- | --------------- | ----------------------------------------------------------------------- |
| 1   | Owner           | Full access, including organization management.                       |
| 2   | Administrator   | Full access except organization management and granting Owner.        |
| 3   | Developer       | Project content read/write; no settings, credentials, or member management. |
| 4   | Read-only       | Read-only access to project content.                                   |

The migration also backfills: every existing `platform.organization_members` row gets role id `1`
(Owner). This is deliberate, not a default-to-least-privilege choice — before M3.0 every registered
member effectively had unrestricted access (there was no role model to restrict them), so backfilling
anything less than Owner would silently revoke access members already had. New members added after
M3.0 get no role automatically; see "Zero-role members" below.

### Enforcement subject and credential-bearing routes

`apps/studio/lib/api/self-platform/rbac/enforce.ts`'s `checkPermission`/`checkPermissionWithContext`
resolve `claims.sub` (the **platform GoTrue session**, i.e. who is logged into the dashboard) to a
`platform.profiles` row, load that member's roles via `getMemberContext`, expand them against
`ROLE_MATRIX`, and evaluate with the same `doPermissionsCheck` evaluator the client uses
(`apps/studio/lib/permissions-check.ts`). The enforcement subject is **always** the dashboard
session — never possession of a project's own data-plane credential. `guardProjectRoute` wraps this
for `[ref]` routes and preserves the existing 404-before-403 order: an unknown `ref` still 404s
before any permission check runs.

Credential-bearing routes that have been hardened per-ref and enforce `secrets:Read` are:

**Full-block (403 when denied):** `pages/api/platform/projects/[ref]/api-keys/temporary.ts`, `pages/api/platform/projects/[ref]/config/index.ts`, `pages/api/platform/projects/[ref]/config/postgrest.ts`, `pages/api/v1/projects/[ref]/api-keys.ts`, `pages/api/v1/projects/[ref]/api-keys/[id].ts` (see "M2.2: credential closure" above).

**Field-masking (200 with secrets stripped when denied):** `pages/api/platform/projects/[ref]/settings.ts` (masks `jwt_secret`, filters the `service_role` entry out of `service_api_keys`), `pages/api/platform/props/project/[ref]/api.ts` (masks `serviceApiKey`).

The `secrets:Read` action is only granted to Owner and Administrator by `ROLE_MATRIX`. This is not an arbitrary restriction: see "Shared-stack JWT secret" above — on the common single-stack deployment, a JWT secret or minted service JWT handed to *any* project is cryptographically valid for every sibling project registered on that same stack. Gating `secrets:Read` to Owner/Administrator means a Developer or Read-only member, who by design only has narrow per-project grants, can never obtain a credential that happens to unlock projects they have no role on.

The two data-plane proxies (`pages/api/platform/projects/[ref]/api/rest.ts`, `pages/api/platform/projects/[ref]/api/graphql.ts`) intentionally use a different, Developer-tier gate (`tenant:Sql:Admin:Write`, "Class R") rather than `secrets:Read` — they forward requests with the service key but never return the raw credential to the caller; Read-only members are still blocked.

### Zero-role members

A member with no `platform.member_roles` row (a fresh GoTrue signup, or an existing member who
hasn't been assigned a role yet) has zero roles, and `checkPermission` fails closed for zero roles:
`GET /platform/profile/permissions` returns `[]`, the project list endpoints return an empty list,
and every `guardProjectRoute`-guarded route 403s. There is intentionally no auto-grant beyond the
one-time Owner backfill above.

M3.1 is scoped to ship an admin UI for assigning roles. Until then, grant a role by inserting
directly into `platform.member_roles` against the running `platform-db`:

```bash
docker exec -it supabase-platform-db psql -U postgres -d platform -c \
  "insert into platform.member_roles (profile_id, role_id) select id, 3 from platform.profiles where gotrue_id = '<gotrue-user-id>' on conflict do nothing;"
```

(`role_id` `3` = Developer in the fixed seed above; substitute the base role id, or the id of a
derived, project-scoped role created directly in `platform.roles`/`platform.role_projects`.)

### Client permission cache staleness

The dashboard's own gating (`usePermissionsQuery`, `apps/studio/data/permissions/permissions-query.ts`)
caches `GET /platform/profile/permissions` with `staleTime: 5 * 60 * 1000` (5 minutes). A role
change made via the `psql` workaround above (or, later, the M3.1 UI) can take up to 5 minutes to be
reflected in what the dashboard's own UI shows or hides for an already-open session. This is a
client-side staleness window only — every server-side `checkPermission`/`guardProjectRoute` call
re-reads `platform.member_roles` on each request, so API-level enforcement is immediate regardless
of what the client has cached.

### Data-plane read-only enforcement

A Read-only member's SQL Editor / query-route traffic is routed over the registry's
`db_user_readonly`-based DSN (`resolveProjectConnection`'s `pgConnReadOnlyEncrypted`, built from
`platform.projects.db_user_readonly`) rather than the read-write DSN. The strength of that
guarantee is entirely the strength of **the actual Postgres role registered in that column** — on a
standard stack that's `supabase_read_only_user` (the role the base images already provision with
`SELECT`-only grants), but `register-project.ts` does not validate that whatever role name you pass
via `--db-user-readonly` (or `POSTGRES_USER_READ_ONLY`) is genuinely read-only at the database
level. Registering a project with a readonly-DSN role that actually has write privileges silently
defeats this guarantee; that check is outside what the platform layer can enforce from here.

### Upgrading an existing platform-db to M3.0

`04-roles.sql` only runs automatically against an **empty** `platform-db` data directory, same as
every prior migration in this file. Apply it by hand once against a running deployment:

```bash
docker exec -i supabase-platform-db psql -U postgres -d platform < docker/volumes/platform/migrations/04-roles.sql
```

This step is **required**, not optional, on upgrade. `getMemberContext` treats a missing
`platform.member_roles` table as "every member has zero roles" (fail-closed, matching the
degradation pattern `projects.ts` already uses for pre-M2.1 data dirs — see "Upgrading an existing
M2 platform-db to M2.1" above), and logs a warn-once message
(`[self-platform] platform.member_roles missing (pre-M3 platform-db) — treating every member as
having ZERO roles (fail-closed). Run docker/volumes/platform/migrations/04-roles.sql to upgrade.`)
the first time it happens. Skipping this migration after upgrading past M3.0 therefore locks every
existing member out of every guarded route until it's applied — deliberately fail-closed rather
than fail-open, but worth calling out explicitly since it degrades silently otherwise (one log line,
no crash).

## M3.1: Member and role management

M3.0 built the role model and its enforcement machinery, but left role assignment as a manual
`psql` operation (see "Zero-role members" above) and left two data-plane routes outside M3.0's
guard sweep. M3.1 exposes that machinery through a real set of member/role-management endpoints,
closes the two guard gaps, and adds an org-level MFA-enforcement flag that, as shipped in M3.1,
was stored but not yet acted on (enforcement shipped in M3.2 — see "MFA enforcement flag: stored
in M3.1, enforced as of M3.2" below).

### Endpoint inventory

| Route | Method(s) | Purpose |
| --- | --- | --- |
| `pages/api/platform/organizations/[slug]/members/index.ts` | GET | List org members (`Member[]`), gated `read:Read` on `organizations` via `guardOrgRoute`. |
| `pages/api/platform/organizations/[slug]/members/[gotrue_id]/index.ts` | PATCH | Assign a role — V2 body only. No `role_scoped_projects` -> org-wide base-role link; with a non-empty `role_scoped_projects` -> **implicit derived-role creation** (there is no standalone create-role endpoint — this is deliberate cloud-API parity). |
| " | DELETE | Remove a member outright (every held role must individually clear a `checkPermission` call, then a last-Owner lockout check runs before the removal itself). |
| `pages/api/platform/organizations/[slug]/members/[gotrue_id]/roles/[role_id].ts` | PUT | Replace an existing derived role's project set. |
| " | DELETE | Unassign one role from one member, garbage-collecting the role row if it's now an orphaned derived role. |
| `pages/api/platform/organizations/[slug]/roles.ts` | GET | List roles, V2 dual-layer shape: `org_scoped_roles` / `project_scoped_roles`. |
| `pages/api/platform/organizations/[slug]/members/invitations.ts` | GET, POST | Was a contract-minimal stub in M3.1, always `{ invitations: [] }` (the members-list UI `Promise.all`s this alongside the members GET, so without it TeamSettings' member list failed to load at all). **Real as of M3.2**: GET lists pending invitations, POST batch-creates them — see "M3.2: Invitations, SMTP, invite-only signup, and MFA enforcement" below. |
| `pages/api/platform/organizations/[slug]/members/mfa/enforcement.ts` | GET/PATCH | Org MFA-enforcement flag — see "MFA enforcement flag" below. |
| `pages/api/platform/organizations/[slug]/entitlements.ts` | GET | Was an unconditional M1 stub (`{ entitlements: [] }`); self-platform mode now also lights up two feature flags, `project_scoped_roles` and `security.enforce_mfa` (both `hasAccess: true`), so TeamSettings/SecuritySettings render their M3.1 UI. Plain self-hosted (`IS_SELF_PLATFORM` false) keeps the M1 empty stub byte-identical. |
| `pages/api/platform/organizations/[slug]/sso.ts` | GET | Stub — always `404 {"message": "Failed to find an existing SSO Provider for this organization"}`. The frontend's `sso-config-query.ts` treats that exact message as "SSO not configured" and renders normally rather than as an error. |

All of these except `entitlements.ts` are `IS_SELF_PLATFORM`-gated (`404 {"message": "Not available on this deployment"}` otherwise); `entitlements.ts` instead keeps the plain-mode M1 empty stub (200) byte-identical — see its row above. All require auth (`withAuth: true`). `entitlements.ts` and `sso.ts` carry no
`guardOrgRoute`/`checkPermission` call — `entitlements.ts` is read-shaped, contract-minimal data
with nothing to protect, and `sso.ts` is a fixed 404 stub.

### Additive grants and the strongest-role rule

Project-scoped derived roles are **additive**, not restrictive: holding one only ever adds
permissions on the projects it lists — it never narrows what a member's org-wide role already
grants elsewhere. `effectiveBaseRoleName` (`apps/studio/lib/api/self-platform/rbac/expand.ts`)
computes, per project ref, the *strongest* base role among every role that applies to it (org-wide
roles apply to every project; derived roles only to their listed refs), ranked by
`BASE_ROLE_ORDER` (`rbac/matrix.ts`: Owner > Administrator > Developer > Read-only). An org-wide
Administrator who is *also* given a derived Read-only role scoped to project X is **not** demoted
to Read-only on X — Administrator still wins there, because the strongest applicable role is
chosen, not the most specific one. `expandPermissions` follows the same additive shape on the
permission-check side: every held role independently contributes its own grant templates; nothing
subtracts a permission a stronger role already grants.

`secrets:Read` is only in the Owner and Administrator grant templates (`ROLE_MATRIX`); Developer
and Read-only's templates never include it, base or derived — no amount of project-scoping can add
an action a role's base template doesn't carry. But a **derived** Owner or Administrator role *does*
carry `secrets:Read`, because `expandPermissions` (`rbac/expand.ts`) expands a derived role using
its base role's templates with that role's own `project_refs` filled in, and the Owner/Administrator
templates are `{ actions: ['%'], resources: ['%'] }`. So an Owner or Administrator role scoped to a
single project X still passes a `secrets:Read` check on X (see `api-keys/temporary.ts`, which checks
`SECRETS_READ` with `projectRef`). Per "Shared-stack JWT secret" (M2.2, above), on the common
single-stack deployment that credential is cryptographically valid for every sibling project on the
stack — so granting a project-scoped Owner/Administrator role is effectively granting stack-wide
credential visibility, same as granting the org-wide role, and should be treated that way. Scoping
Owner/Administrator to one project is **not** a credential-containment mechanism.

This is not a privilege-escalation path: only an existing Owner can create a derived Owner, only an
existing Owner or Administrator can create a derived Administrator (`DENY_OWNER_ROLE_GRANTS` in
`rbac/matrix.ts`), and both grantors already hold `secrets:Read` themselves. Stripping Class C
(`secrets:*`) actions from derived-role expansions — so "Administrator on project X" could mean
admin-without-credentials — is recorded as a candidate M3.2+ hardening, not something M3.1 does.

### Empty derived role = zero grants (I1)

`expandPermissions` (`rbac/expand.ts`) special-cases a **derived** role (`!isOrgScopedRole(role)`,
i.e. `role.id !== role.baseRoleId`) whose `projectRefs` list is empty: that role contributes no
grant templates at all. This matters because every API path that creates or updates a derived
role's project set already refuses an empty list — PATCH-assign-with-scope, PUT-replace,
`createDerivedRoleWithAssignment`, and `replaceRoleProjects` all 400 on
`role_scoped_projects: []` — but an operator who inserts directly into
`platform.roles`/`platform.role_projects`/`platform.member_roles` (the documented M3.0 workaround,
or any future ad hoc fix) can still produce a derived-role row with no linked projects. Checking
`isOrgScopedRole` (an id-equality test) *before* checking for an empty project list, rather than
using an empty `projectRefs` list as the org-wide signal, is what makes a hand-inserted
empty-scope derived role grant nothing instead of silently behaving like unrestricted org-wide
access.

### Owner-protection boundary

`ROLE_MATRIX['Administrator']` (`rbac/matrix.ts`) attaches a restrictive deny
(`DENY_OWNER_ROLE_GRANTS`) on `create`/`delete` of `user_invites`/`auth.subject_roles` whenever
`resource.role_id === OWNER_ROLE_ID` (`1`, the seeded Owner base role). Every mutating role route
threads the relevant role id into the guard's `data: { resource: { role_id } }` so this condition
actually evaluates:

- **PATCH-assign** (`members/[gotrue_id]/index.ts`): the request body always carries a **base**
  role id — the frontend never sends a derived id on assign. An Administrator's attempt to grant
  org-wide Owner (`role_id: 1`, no `role_scoped_projects`) and an attempt to create a *derived*
  Owner role (`role_id: 1` with `role_scoped_projects` — the derived role is still created from
  base id `1`) both deny at the same `role_id === 1` check.
- **DELETE** on `members/[gotrue_id]/roles/[role_id].ts`, and the per-held-role loop inside
  `members/[gotrue_id]/index.ts`'s DELETE, evaluate the **path** role id instead. A derived
  Owner-based role has its own freshly generated id (`!= 1`), so revoking it never hits the
  `role_id === 1` deny — an Administrator **can** revoke an existing derived Owner-based role;
  only the org-wide Owner id itself is protected. This mirrors the frontend's `rolesRemovable`
  evaluation (`MemberActions.tsx`), which keys off the concrete role id being removed, not
  "is this role's base Owner".
- Independent of the matrix deny, both DELETE paths run a server-side lockout check
  (`countOtherOrgScopedOwnerHolders`): removing a member's (or role's) **org-scoped** Owner role
  400s with `Cannot remove the last Owner of the organization` when no other profile holds an
  org-scoped Owner role afterward. This is a headcount check, not a role-matrix check, so it fires
  regardless of who is making the call — including an Owner acting on another Owner.

### MFA enforcement flag: stored in M3.1, enforced as of M3.2

`docker/volumes/platform/migrations/05-mfa-enforcement.sql` adds
`platform.organizations.enforce_mfa boolean not null default false`. GET/PATCH
`.../members/mfa/enforcement` (`getOrgMfaEnforced`/`setOrgMfaEnforced`,
`lib/api/self-platform/organizations.ts`) read and write that column; PATCH is gated
`write:Update` on `organizations`, which the matrix restricts to Owner (Administrator carries a
restrictive deny on `write:%`/`organizations`, same as every other org-level write). **In M3.1 the
flag was only stored and surfaced — flipping it to `true` did not block anything.** As of M3.2,
actual enforcement is live at two checkpoints (both keyed off `claims.aal !== 'aal2'`): the
invite/join flow rejects a join for a member without verified MFA, and the session layer
(`guardOrgRoute`/`guardProjectRoute`) blocks org/project API access once `enforce_mfa` is on — see
"MFA enforcement" under "M3.2: Invitations, SMTP, invite-only signup, and MFA enforcement" below
for the exact ordering and both checkpoints in full.

### Upgrading an existing platform-db to M3.1

`05-mfa-enforcement.sql` only runs automatically against an **empty** `platform-db` data
directory, same as every prior migration in this file. Apply it by hand once against a running
deployment:

```bash
docker exec -i supabase-platform-db psql -U postgres -d platform < docker/volumes/platform/migrations/05-mfa-enforcement.sql
```

Unmigrated behavior differs by direction, not fail-closed everywhere: `getOrgMfaEnforced` catches
the missing-column error and returns `false` (MFA enforcement reports as off), logging a
warn-once message the first time it happens; `setOrgMfaEnforced`'s `UPDATE` has no such catch, so
a PATCH against an unmigrated database propagates the raw column-missing error and the route
returns `500` via `apiWrapper`'s catch-all, rather than silently succeeding or silently degrading.

Apply `05-invitations.sql` (M3.2 — organization invitations):

```bash
docker exec -i supabase-platform-db psql -U postgres -d platform \
  < docker/volumes/platform/migrations/05-invitations.sql
```

### v1 routes: functions list and TypeScript typegen now RBAC-guarded

`pages/api/v1/projects/[ref]/functions/index.ts` (GET) and
`pages/api/v1/projects/[ref]/types/typescript.ts` (GET) now call `guardProjectRoute` under
`IS_SELF_PLATFORM` — the functions list requires `functions:Read`, typegen requires
`tenant:Sql:Admin:Read` (the same tier as the pg-meta listing family, since typegen reads the
tenant database's own schema). `guardProjectRoute` resolves the ref first, so an unknown ref still
404s before any permission check runs, same order as every other guarded route.

**The functions artifact store itself is still global, not per-ref**
(`getFunctionsArtifactStore`, `lib/api/self-hosted/functions.ts`) — the new guard controls **who**
may read the functions list for a given `ref`, it does not partition the underlying artifact
storage by project. Every registered project's functions list currently reads from the same
on-disk store; per-ref artifact isolation is separate, unimplemented future work.

### register-project CLI: read-only DSN password alignment

M3.0's "Data-plane read-only enforcement" (above) already flags that the Read-only role's
guarantee is only as strong as the actual Postgres role registered in `db_user_readonly`. There is
a second, easy-to-miss precondition for that DSN to authenticate at all: `resolveProjectConnection`'s
`fromRow` (`lib/api/self-platform/resolve-connection.ts`) builds **both** the read-write and
read-only DSNs from the **same** decrypted `db_pass` — only the username differs (`row.db_user` vs.
`row.db_user_readonly`). `register-project.ts` never collects a separate readonly password; it only
takes one `--db-pass`. Consequently, whatever PG role `--db-user-readonly` names (default
`supabase_read_only_user`) must have its actual Postgres password set to the same value as the
registered `db_pass`, or the readonly DSN simply fails to authenticate for every Read-only member.
On a standard docker-compose stack, `supabase_read_only_user`'s password is **not**
`POSTGRES_PASSWORD` by default — align it before registering:

```bash
docker exec supabase-db psql -U postgres -c "ALTER ROLE supabase_read_only_user PASSWORD '<POSTGRES_PASSWORD>';"
```

## M3.2: Invitations, SMTP, invite-only signup, and MFA enforcement

M3.1 shipped role assignment, member management, and an org-level `enforce_mfa` flag that was only
stored, never acted on — and left `members/invitations.ts` as a permanent `{ invitations: [] }`
stub. M3.2 closes all three: real organization invitations (create, list, revoke, accept-by-token),
an actual outbound email (GoTrue-mailed, Mailpit locally), invite-only signup (public
self-registration is off), and live MFA enforcement (the M3.1 flag now actually blocks non-aal2
sessions instead of just being readable).

### Endpoints

Five routes across two files. `pages/api/platform/organizations/[slug]/members/invitations.ts`
(the collection) handles `GET` — list **pending** invitations only (`accepted_at is null`), gated
`read:Read` on `organizations` via `guardOrgRoute` so it matches the members-list GET it feeds
(the members UI `Promise.all`s the two together) — and `POST` — batch-create for one shared
`role_id` (+ optional shared `role_scoped_projects`) across a list of emails, gated `write:Create`
on `user_invites` with `data: { resource: { role_id } }` so the matrix's owner-protection deny
fires for an Administrator trying to invite an Owner. Each email in the batch runs its own
already-member / already-pending / send-failure pipeline independently (see the invariant below),
so one bad email in a batch doesn't sink the rest.

`pages/api/platform/organizations/[slug]/members/invitations/[id_or_token].ts` (the item route)
handles the other three: `DELETE` (revoke by numeric id — a guarded, member-management action,
with its own owner-protection re-check per the invite's `role_id`), `GET` (read by token — a
capability check, not a membership check, since the invitee isn't an org member yet), and `POST`
(accept by token — fail-closed re-check of everything the GET showed, then one atomic claim). All
three live in one file because Next.js's file-based router gives `{id}` and `{token}` **the same
dynamic path segment** — `[id_or_token].ts` can't coexist with a separate `[id].ts`/`[token].ts`
pair at the same route depth, so the single handler dispatches on HTTP method instead (`DELETE`
parses the segment as a numeric id; `GET`/`POST` treat it as an opaque token string). The by-token
paths are deliberately info-hiding: an unknown org slug and a missing/foreign-org token both
return `200 { token_does_not_exist: true }` — never a 404 — so a guess never reveals whether the
org itself exists.

### Invite email: GoTrue `/invite` vs `/otp`, Mailpit, and real SMTP

`lib/api/self-platform/invite-email.ts`'s `sendInvitationEmail` picks one of two GoTrue admin
endpoints depending on whether the invited address is already a GoTrue user: a brand-new address
goes through `POST /invite` (GoTrue creates the user and mails an invite link); an address GoTrue
already recognizes (detected from `/invite`'s 4xx response — status 422/400/409 plus an
error code/message matching `/exist|registered/i`, verified live against GoTrue v2.189.0) falls
back to `POST /otp` with `create_user: false` (a magiclink for an existing account). **Both calls
pass `redirect_to` as a URL query parameter, never in the JSON body** — GoTrue only honors
query-string `redirect_to` on these endpoints (live-verified; a body field is silently ignored and
GoTrue falls back to `GOTRUE_SITE_URL`), so the emailed `/verify` link carries the full
`/join?token=<invitation-token>&slug=<org-slug>` redirect only because the URL itself carries it.
The collection `POST` handler enforces a hard invariant — **a pending invitation row implies an
email was sent**: it inserts the row first, then calls `sendInvitationEmail`, and if that throws it
deletes the just-inserted row and reports that email as failed, rather than leaving a row that no
one was ever notified about. Locally, delivery goes through `platform-mail`
(`docker-compose.platform.yml`, `axllent/mailpit:v1.20`, SMTP on `1025` / web UI on `8025`) with
empty `GOTRUE_SMTP_USER`/`PASS` by default — Go's stdlib `PlainAuth` refuses to send credentials
over a non-TLS connection unless the SMTP host is literally `localhost` (ours is `platform-mail`),
so a non-empty user/pass here makes every send fail; empty credentials make GoTrue skip AUTH
entirely, which Mailpit's `MP_SMTP_AUTH_ACCEPT_ANY`/`MP_SMTP_AUTH_ALLOW_INSECURE` config permits.
To point at a real provider instead, override `PLATFORM_SMTP_HOST`/`PORT`/`USER`/`PASS`/
`ADMIN_EMAIL`/`SENDER_NAME` in `docker/.env` (gitignored, never committed) — a real 587/465+TLS
provider makes `PlainAuth`'s non-`localhost` check pass legitimately instead of needing the
empty-credential workaround.

> **Security:** Mailpit is a **local dev mail sink only** — it has no authentication of any kind.
> Its web UI (`8025`) shows every message it has ever received in full, including every invitation
> email, and each invitation email carries a `/join?token=<invitation-token>` link that is
> effectively a **passwordless account-takeover link** for whoever clicks it first. Anyone who can
> reach the Mailpit UI can therefore mint themselves org access. `docker-compose.platform.yml` binds
> both published ports to `127.0.0.1` (`127.0.0.1:${PLATFORM_MAILPIT_SMTP_HOST_PORT:-1025}:1025` /
> `127.0.0.1:${PLATFORM_MAILPIT_UI_HOST_PORT:-8025}:8025`) specifically so neither is reachable from
> the LAN or the public internet — only processes on the same host can reach them. **Never use
> Mailpit as the mail path for a shared, multi-team, or production deployment.** Configure a real
> SMTP provider via the `PLATFORM_SMTP_*` overrides in `docker/.env` (see above) instead.

### Invite-only signup

`docker-compose.platform.yml` now sets `GOTRUE_DISABLE_SIGNUP: 'true'` — this is the real gate;
GoTrue itself refuses to create new accounts outside the admin API's `/invite`/`/admin/users`
paths. `pages/api/platform/signup.ts` (self-platform mode) no longer proxies to GoTrue at all; it
unconditionally returns `403` with a purposeful message ("Signups are invite-only on this
deployment...") instead of surfacing GoTrue's generic refusal. The sign-up page and its button
**stay visible** to a signed-out visitor — there is no zero-fork way to hide them conditionally —
they simply 403 on submit now. See "Bootstrapping the first admin" below for how the very first
dashboard user gets created when public signup is off.

### MFA enforcement

The `enforce_mfa` flag itself (`platform.organizations.enforce_mfa`, migration
`05-mfa-enforcement.sql`) and its GET/PATCH route shipped in M3.1 as Owner opt-in per org — PATCH
stays gated `write:Update` on `organizations`, which the matrix restricts to Owner. M3.2 is what
makes flipping it to `true` actually do something. Two enforcement points, both keyed off the same
`claims.aal !== 'aal2'` check: the join flow (`invitations/[id_or_token].ts`'s `GET` and `POST`)
returns `403 { message: 'MFA required to join this organization' }` when the target org has
`enforce_mfa` on and the caller's session isn't `aal2`, checked *after* the accepted/consumed
re-check so token state is never leaked ahead of the MFA check; and the session layer
(`guardOrgRoute`/`guardProjectRoute` in `lib/api/self-platform/rbac/enforce.ts`) returns
`403 { message: 'MFA required to access this organization' }` on **every** org- or project-scoped
route once the caller's org has `enforce_mfa` on, placed after the 404 (membership/ref resolution)
and before the permission check — so a non-member or an unknown ref still 404s first, and MFA
state is never revealed to someone who isn't already established as a member. **The accepted UX
cost**: there is no dedicated "please enroll MFA" gate screen. An existing, previously-fine,
non-MFA member of an org whose Owner just flipped `enforce_mfa` on simply starts getting 403 toasts
on every subsequent org/project API call, with no interstitial screen walking them to enroll — they
have to independently find `/account/security` and enroll TOTP themselves before the org becomes
usable again (spec §6.3). This was accepted as a scoping cut, not fixed further in M3.2.

**Owner self-lockout note**: an Owner who enables `enforce_mfa` while their own session is below
aal2 immediately 403s themselves out of every org/project API too — there is no exemption for the
org's own Owner. This is **not** a hard lockout: `/account/security` is account-level, not
org-guarded, so the Owner can still reach it, enroll TOTP there, and get a fresh aal2 session to
recover access.

### `05-invitations.sql`

`docker/volumes/platform/migrations/05-invitations.sql` (Task 1) adds `platform.invitations` plus
the partial unique index enforcing one pending invite per `(organization_id, invited_email)`. The
"Upgrading an existing platform-db to M3.1" section above already carries the hand-apply command
for it (cross-referenced there rather than duplicated here) since it ships alongside the M3.1
migration-upgrade instructions in this file.

### Accepted limitations (spec §13)

- **Scoped-accept is anchored on single-org membership.** Both `acceptInvitationOrgWide` and
  `acceptInvitationScoped` (`lib/api/self-platform/invitations.ts`) grant the `member_roles` row
  only if the accepting profile already has a `platform.organization_members` row for that org —
  which first-login boot creates for the one default org every user lands in. This holds as long as
  a deployment stays single-org-per-member in practice; it is not re-validated against a world where
  a profile might belong to multiple organizations.
- **A revoked invite can leave a passwordless, zero-role GoTrue account behind.** Revoking only
  deletes the `platform.invitations` row. If GoTrue had already created the underlying user via
  `/invite` (or the invitee had already verified it), that GoTrue account persists — no password, no
  `platform.organization_members`/`member_roles` row. This is fail-closed (the account has zero
  access anywhere) and harmless, just an orphaned GoTrue account with no cleanup path today.
- **Zero-role legacy members can't be re-invited through the UI.** The collection `POST`'s
  already-member check (`getExistingMemberEmails`) matches on `platform.organization_members`
  membership, not on holding any role — so a zero-role member (a pre-M3.0 legacy account, or anyone
  whose roles were all removed without removing them from the org) is rejected with "This user is
  already a member of the organization." Direct role assignment via the existing M3.1 PATCH member
  endpoint is the path to fix that; re-inviting is not.
- **No expired-invitation-row reaper.** The 24h `expires_at` (migration default) is enforced at
  accept time (both accept CTEs gate on `expires_at > now()`) and surfaced at GET-by-token
  (`expired_token`), but nothing ever deletes an expired, unaccepted row — it sits until someone
  revokes it. "Resend" is revoke-then-invite (delete + recreate), not an in-place update; there is
  no cron/reaper cleaning up rows that simply expired unattended.
- **Extreme-race orphaned-derived-role residue (carried from Task 8).**
  `createDerivedRoleWithAssignment`'s role-row and `role_projects`-link inserts run unconditionally
  inside the same atomic statement; only the final `member_roles` grant is gated on the target
  profile's `organization_members` row still existing. If membership is removed in the narrow
  window before this statement runs, the derived role (with its project links) is still created but
  never assigned to anyone — an orphaned, unassigned derived role. Narrow window, internal-scale
  exposure only, and not a security issue (an unassigned role grants nothing to anyone); accepted as
  residue rather than fixed further.

The M3.0/M3.1 shared-stack-JWT-secret boundary ("Shared-stack JWT secret" above) and the additive,
never-narrowing grants model ("Additive grants and the strongest-role rule" above) are unchanged by
M3.2 — nothing in invitations, SMTP, invite-only signup, or MFA enforcement weakens either.

### Bootstrapping the first admin

Public signup is disabled (`GOTRUE_DISABLE_SIGNUP=true`). Create the first
dashboard user via the platform GoTrue admin API, using a service-role JWT
signed with `PLATFORM_JWT_SECRET` (from `docker/.env`):

```bash
SECRET="$(grep '^PLATFORM_JWT_SECRET=' docker/.env | cut -d= -f2)"
# Mint a 60s service_role JWT (HS256) — or reuse the studio mint-jwt helper.
# Then:
curl -s -X POST 'http://localhost:8110/admin/users' \
  -H "Authorization: Bearer <service_role_jwt>" \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin@internal.test","password":"<pw>","email_confirm":true}'
```

Log in once as this user (first login auto-creates the platform profile +
default-org membership), then grant Owner in the platform db:

```bash
docker exec -i supabase-platform-db psql -U postgres -d platform -c \
  "insert into platform.member_roles (profile_id, role_id)
   select pr.id, 1 from platform.profiles pr
   where pr.primary_email = 'admin@internal.test' on conflict do nothing;"
```

## M4: Project-level Auth config (store + apply)

M1 through M3.2 covered login, multi-project registry, RBAC, and invitations, but the
`/project/{ref}/auth` **settings** panel itself (provider toggles, SMTP, hooks, rate limits, and
every other GoTrue-tunable field) was out of scope — see "Auth settings and Storage settings
config endpoints are unimplemented" under "Known limitations (M1)" and the `auth/[ref]/config`
line under "M2 boundary" above. M4 implements that panel end to end: a per-project desired-state
store in `platform-db`, RBAC-gated GET/PATCH routes that back the Studio UI, and an operator CLI
that pushes the stored config live by restarting GoTrue.

### What it is

Studio's Auth settings panel (`/project/{ref}/auth`) is now served by
`GET`/`PATCH /platform/auth/{ref}/config` (the full GoTrue config contract) and
`PATCH /platform/auth/{ref}/config/hooks` (the `HOOK_*` subset — Custom Access Token, Send Email,
Send SMS, Before/After User Created, Password/MFA Verification Attempt hooks), both backed by one
table, `platform.auth_config` (`docker/volumes/platform/migrations/06-auth-config.sql`): one row
per project `ref`, a non-secret `config` jsonb column and an AES-encrypted `secrets` jsonb column.
This is a **desired-state** store, not a live mirror of GoTrue — GoTrue itself has no runtime
config API, it only reads `GOTRUE_*` env at container boot, so writing here never touches the
running GoTrue process by itself (see "Stored ≠ live" below). `readAuthConfig` merges the stored
row over a curated, TypeScript-enforced-complete `DEFAULTS` baseline
(`apps/studio/lib/api/self-platform/auth-config.ts`) so every one of the contract's ~237 fields is
always present in the GET response, configured or not.

### Upgrading an existing platform-db to M4

`06-auth-config.sql` only runs automatically against an **empty** `platform-db` data directory,
same as every prior migration in this file. Apply it by hand once against a running deployment:

```bash
docker exec -i supabase-platform-db psql -U postgres -d platform -v ON_ERROR_STOP=1 \
  < docker/volumes/platform/migrations/06-auth-config.sql
```

It is a plain `create table if not exists`, so it is safe to re-run.

### Stored ≠ live: applying config with `apply-auth-config`

Editing and saving the Auth settings panel in Studio only **persists** the change to
`platform.auth_config` — it does not, by itself, change how the running GoTrue container behaves.
To make a project's stored config live, an operator runs the CLI:

```bash
npx tsx docker/scripts/platform/apply-auth-config.ts <ref> [--target <container>] [--dry-run]
```

This reads the row for `<ref>` directly from `platform-db` (via `docker exec ... psql`, no new
DB-client dependency, mirroring `register-project.ts`), decrypts its `secrets`, renders the merged
`config`+`secrets` into `GOTRUE_*` environment variables, writes them to a generated
`docker/docker-compose.auth-override.yml`, and runs
`docker compose -f docker-compose.yml -f docker-compose.auth-override.yml up -d <target>` to
restart the target GoTrue service with the override applied. `--dry-run` prints the rendered
compose override (with secret-sourced values masked as `******`) and a summary line to stdout
without writing the file or touching Docker at all — safe to preview before applying.

**The default apply target is `auth` — the docker-compose *service key*
(`docker/docker-compose.yml`'s `auth:` block), not the container's `container_name`
(`supabase-auth`).** `docker compose up -d`/`-f` file-merging resolves services by their service
key, so the override file's `services: auth: environment: ...` block only takes effect if the
service passed to `up -d` matches that same key. Override the target with `--target <name>` or the
`PLATFORM_AUTH_CONTAINER` environment variable if your stack names the auth service differently;
`PLATFORM_COMPOSE_DIR` overrides where the override file is written and which directory `docker
compose` runs from (defaults to the repo's `docker/` directory), and `PLATFORM_DB_CONTAINER`
overrides which container `apply-auth-config` reads the stored config from (defaults to
`supabase-platform-db`).

### Security

**The generated `docker/docker-compose.auth-override.yml` contains DECRYPTED secrets** — every
provider client secret, SMTP password, and hook secret configured for that project, in plaintext,
rendered as `GOTRUE_*_SECRET` / `GOTRUE_SMTP_PASS` / `GOTRUE_HOOK_*_SECRETS` environment values.
`apply-auth-config` writes it `chmod 600` and it is gitignored
(`docker/docker-compose.auth-override.yml`, `docker/*.auth-override.yml` in the repo's
`.gitignore`) — **never commit it, never share it**, and treat any copy of it (backups, CI
artifacts, support bundles) as containing live credentials.

At rest, `platform.auth_config.secrets` stores every secret field AES-encrypted with
`PLATFORM_ENCRYPTION_KEY` (the same key and `crypto-js` scheme `platform.projects`' `*_enc`
columns already use — see "`PLATFORM_ENCRYPTION_KEY` — required, back it up" above; losing it is
equally unrecoverable for this table). Two invariants hold independent of that encryption:

- **`GET` always masks secret fields.** `readAuthConfig` blanks every key in `SECRET_FIELDS` (37
  fields: every OAuth provider's client secret, `SMTP_PASS`, every `HOOK_*_SECRETS`, SMS
  provider credentials, the CAPTCHA secret) to `''` before returning the response — the UI never
  receives a decrypted or even ciphertext value, only "is something configured" via the
  surrounding non-secret fields (e.g. `EXTERNAL_GITHUB_ENABLED`). Secret fields are write-only from
  the API's perspective.
- **`PATCH` never overwrites a stored secret with a blank/masked value.** Because the panel only
  ever echoes back the masked `''` for a secret field the operator didn't touch, `writeAuthConfig`
  /`writeHookConfig` silently drop any secret field whose incoming value is `''`, `null`, or
  `undefined` rather than encrypting and storing it — saving the form again without retyping a
  secret leaves the previously-stored ciphertext untouched.

### Shared-stack semantics

Same boundary as everywhere else in this file that touches the shared GoTrue instance (see
"Shared-stack JWT secret" under M3.0 above): on the common single-stack deployment, one
`supabase-auth` serves every registered project, so `apply-auth-config` restarting it applies
**stack-wide**, not just to the ref you passed. Applying project A's config changes the live
behavior every other project on that stack observes from GoTrue too (rate limits, enabled
providers, mailer templates, everything `GOTRUE_*`-driven). Genuine per-project isolation of live
GoTrue behavior requires a genuinely separate stack (its own GoTrue process) per project, same as
every other "shared-stack" caveat in this document — not something M4 changes.

### RBAC

`custom_config_gotrue` is gated like every other resource in the `ROLE_MATRIX`
(`apps/studio/lib/api/self-platform/rbac/matrix.ts`): `GET /platform/auth/{ref}/config` requires
only `read:Read`, which both `Developer` and `Read-only`'s `READ_ACTIONS` grant on every resource
(`resources: ['%']`) — any project member can view the panel. `PATCH` on either
`/config` or `/config/hooks` requires `write:Update`, which only `Owner` and `Administrator` carry
(their `{ actions: ['%'], resources: ['%'] }` templates) — `Developer`'s narrower
`DEVELOPER_WRITE_ACTIONS` list does not include a generic `write:%`/`write:Update` grant, so a
Developer can view but not change Auth config, and a Read-only member can do neither. Both routes
route through `guardProjectRoute`, so an unknown `ref` still 404s before either check runs.

## M5.0: Dual-track provisioning (UI create/delete + stack metadata)

M1 through M4 assumed a project's registry row was created out of band — by the
`register-project` CLI, or the `--from-current-env` bootstrap for `default` — there was no way to
create or remove a project from inside Studio itself. M5.0 adds that: a two-mode create form on
`/new/{org-slug}` (replacing the cloud wizard in self-platform mode), a deregister-only delete
panel, and two new columns on `platform.projects` that record how each project's underlying
infrastructure was provisioned.

### Creating a project

`POST /platform/projects` (`pages/api/platform/projects/index.ts`) accepts a `mode` field, one of
two values:

- **`shared-db`** ("Quick create" in the UI) — creates a brand-new database on an
  already-registered **external** host stack's Postgres server, over the same pg-meta channel the
  dashboard already uses for query execution (the same trick as "Registering a second project
  without a second stack" under M2 above, automated). The new row clones the host's gateway URL,
  API keys, and JWT secret verbatim — same ciphertext, same stack, so the shared-stack JWT-secret
  caveat from M2.2/M3.0 applies to it too. **Analytics columns are not cloned** —
  `logflare_url`/`logflare_token_enc` are always `NULL` on a quick-created row, so per-project
  analytics stays honestly "not configured" until you separately register Logflare details for it.
  The write path is insert-first: the row lands as `COMING_UP`, then
  `create database "<ref, hyphens replaced with underscores>"` runs against the host, then the row
  flips to `ACTIVE_HEALTHY`. If the `CREATE DATABASE` statement itself fails (e.g. the name already
  exists on that host), the inserted row is deleted and the request fails with the underlying error
  message; a process crash between a successful `CREATE DATABASE` and the status flip instead
  leaves a visible `COMING_UP` row, removable like any other project via delete. The chosen host
  stack must belong to the same organization as the new project — cross-org hosting is refused
  (`InvalidHostStack`), since it would otherwise clone another org's gateway URL and key
  ciphertexts onto a project outside that org.
- **`external`** ("Attach existing stack" in the UI) — the register CLI's flags as a form: the
  connection is probed with a `select 1` through pg-meta *before* the row is inserted, and secrets
  are AES-encrypted at rest with `PLATFORM_ENCRYPTION_KEY`, exactly like `register-project.ts`.

`ref` is validated against the same pattern in two places — once at the route, before any DB work
runs, and again inside the data layer immediately before the value is interpolated into the
`CREATE DATABASE` identifier (a second, in-module guard added during review, since the route-level
check alone left a theoretical gap between the two layers).

Creating a project requires `write:Create` on `projects`, which both `Owner` and `Administrator`'s
wildcard grant (`actions: ['%']`) carries.

### Deleting a project

**Delete is deregister-only.** `DELETE /platform/projects/{ref}` removes the registry row — the
real database is never dropped. Two foreign keys cascade off it automatically
(`role_projects.project_id` and `auth_config.ref`, both `on delete cascade`); a second statement
then garbage-collects any derived role left scoped to zero projects by that cascade (this has to be
a separate statement — a CTE attached to the same `delete` would see the pre-cascade snapshot, not
the result of the cascade). `ref='default'` is refused with `400`. Check order: an unknown `ref`
still 404s first (the connection resolver runs before any permission check), then `403` for anyone
without the required grant, then the `400` default-refusal, then the delete itself.

If you no longer need the underlying database, drop it manually on the host
stack:

```bash
docker exec supabase-db psql -U supabase_admin -c 'drop database "<db_name>";'
```

Note that quick-created databases are owned by `supabase_admin` (the user
pg-meta connects as), so the drop command must run as that role. Re-creating a
project with the same ref via quick-create fails while the old database still
exists — `CREATE DATABASE` errors with "already exists". That error is the
signal to run the manual drop above (or pick a different ref).

RBAC is stricter than creation: deletion requires `write:Delete` on `projects`, and
`Administrator`'s otherwise-full wildcard grant is carved out by a restrictive deny specific to
that action/resource pair (`apps/studio/lib/api/self-platform/rbac/matrix.ts`) — only `Owner` can
deregister a project.

### UI

Self-platform mode swaps two upstream cloud-only surfaces:

- `/new/{org-slug}` renders a two-tab form (Quick create / Attach existing stack) instead of the
  cloud creation wizard.
- Settings → General renders a "Remove project from platform" panel instead of the upstream delete
  panel — its copy is explicit that the database is preserved, and it disables the button for the
  `default` ref and for anyone without `write:Delete`, the same gates the API enforces.
  Confirmation is the same type-the-ref `TextConfirmModal` pattern used by several delete flows
  elsewhere in Studio (including the upstream delete-project panel it replaces).

### Stack metadata

`platform.projects` gains two columns (`docker/volumes/platform/migrations/07-stack-metadata.sql`):
`stack_kind` (`external` | `shared-db` | `k8s` — the last reserved for M5.1) and `stack_meta`
(jsonb; a `shared-db` row stores `{"host_ref": "<ref>"}`, an `external` row stays `{}`). Both are
purely informational in M5.0 — `resolveProjectConnection` reads neither column, so every row stays
fully self-contained regardless of how it's labeled. Existing rows backfill to `external` via the
column default. Relabel a pre-M5.0 shared-database row (e.g. `proj-b`, registered by hand under
M2's "second database, same stack" pattern) for display accuracy with:

```sql
update platform.projects
set
  stack_kind = 'shared-db',
  stack_meta = '{"host_ref": "default"}'
where ref = 'proj-b';
```

The register CLI stays fully supported and remains the bootstrap path for the first project; it
gained a `--stack-kind` flag (default `external`, validated against the same three values) so a
manually-registered row can be labeled correctly too.

### Upgrading an existing platform-db to M5.0

`07-stack-metadata.sql` only runs automatically against an **empty** `platform-db` data directory,
same as every prior migration in this file. Apply it by hand once (safe to re-run — `add column if
not exists`):

```bash
docker exec -i supabase-platform-db psql -U postgres -d platform -v ON_ERROR_STOP=1 \
  < docker/volumes/platform/migrations/07-stack-metadata.sql
```

A pre-M5.0 platform-db degrades gracefully: `apps/studio/lib/api/self-platform/projects.ts`
detects the missing columns and logs, once,
`[self-platform] platform.projects has no stack columns (pre-M5.0 platform-db). Run
docker/volumes/platform/migrations/07-stack-metadata.sql to upgrade.`, then treats every row as
`external` until the migration is applied.

## M6.0: Real health probing

Since M1 (see "Service-health endpoints always report healthy" under "Known limitations (M1)"
above), `/api/v1/projects/{ref}/health` and `/api/platform/projects/{ref}/databases-statuses` were
contract-minimal stubs that echoed `ACTIVE_HEALTHY`/`healthy: true` unconditionally — the
ServiceStatus dots on a project's home page and the project-list badges were fake-green regardless
of what was actually running. M6.0 replaces both routes' status source, in self-platform mode,
with a real probe engine (`apps/studio/lib/api/self-platform/health.ts`) that checks each
registered project's own stack directly. This is still zero-agent: nothing runs on the stack side,
Studio just calls it over the network the dashboard already uses.

### How a probe works

- **db** — `select 1` through the same pg-meta channel the dashboard uses for query execution
  (`POST ${PG_META_URL}/query` with `x-connection-encrypted` set to the project's decrypted,
  re-encrypted read-write DSN — the same connection the dashboard's own queries depend on, not the
  read-only one, so a read-replica-only outage doesn't falsely report the project dead).
- **auth / rest / storage / realtime** — a GET request against the project's own gateway
  (`kong_url`) with its anon key (`apikey` + `Authorization: Bearer` headers):
  `/auth/v1/health`, `/rest/v1/`, `/storage/v1/status`, `/realtime/v1/websocket`.

Each probe has its own 5-second timeout (`AbortSignal.timeout`); all five run in parallel, so one
slow/unreachable service doesn't delay the others.

### Status mapping (and one exception)

**db** never goes through Kong — it's a direct pg-meta query — so it only ever reports
`ACTIVE_HEALTHY` (the `select 1` succeeded) or `UNHEALTHY` (it didn't, with the underlying error
message); there is no `DISABLED` state for `db`.

For the four gateway-fronted services, **auth, rest, storage, realtime**: a 2xx response maps to
`ACTIVE_HEALTHY`; a Kong response whose body contains `no Route matched` maps to `DISABLED` (the
service isn't deployed behind that gateway — not an error); anything else — a non-2xx status, a
timeout, or a network error — maps to `UNHEALTHY` with the HTTP code and, where the body is JSON,
its message attached as `error`. `auth` additionally attaches GoTrue's health-check JSON body as
`info` on success.

**`realtime` is the one exception, and it is intentional, not an oversight.** A live spike against
the stock self-hosted stack (`supabase/realtime` behind the standard
`docker/volumes/api/kong.yml`) found that realtime's actual readiness API is **not exposed through
Kong** on a stock deployment — both candidate readiness paths 404 straight from the container, and
the one endpoint that does report real up/down state (the per-tenant `/api/tenants/<tenant>/health`
route) is Kong-blocked with a constant `403` regardless of whether realtime is actually running.
The websocket route (`/realtime/v1/websocket`) is the only path that discriminates at all: it
answers `403` while realtime is up and `503` once it's down. So realtime is probed as a
**liveness** check, not a readiness one — *any* sub-500 HTTP response (`403` included) is treated
as `ACTIVE_HEALTHY` proof the service is reachable through the gateway; only a `5xx` or a
timeout/network error maps to `UNHEALTHY`. This is a materially weaker guarantee than the other
four services get — it can't distinguish "realtime is healthy" from "realtime is up but otherwise
broken" — but it is honest about what a stock Kong config can actually tell you.

**The Kong `DISABLED` mapping has a gateway-shaped caveat, too.** It fires when Kong's own
router returns a 404 whose body says `no Route matched`. On the stock
`docker/volumes/api/kong.yml`, the `dashboard` route is a catch-all (`paths: ["/"]`) that matches
every otherwise-unmapped path ahead of Kong's router-level 404 — so a genuinely unmapped path on
*that* gateway hits the dashboard route's basic-auth plugin and comes back `401` instead. In
practice this means `DISABLED` may never trigger against the stock docker-compose gateway; the
mapping stays meaningful for attached stacks running a minimal or non-catch-all Kong config.

### Cache and write-through

Probes are on-demand, not scheduled: a request to either route triggers a probe only on a cache
miss. All five results for a project are cached together for **20 seconds**
(`CACHE_TTL_MS`) — repeated dashboard polling within that window is served from cache, not
re-probed. On a cache miss (a *fresh* probe), the result is written back to the registry: the
project's `status` column is set to `ACTIVE_HEALTHY` or `UNHEALTHY` **derived from the db probe
only** — an unhealthy `auth`/`rest`/`storage`/`realtime` shows up in the ServiceStatus dots but
does not flip the project's overall status — and `last_health_at` is set to `now()`. The write
itself only fires when the computed status differs from the stored one or the last write is more
than 60 seconds old, bounding write volume under repeated polling; a failed write is logged
(`console.warn`) and never surfaces to the caller, since a probe's job is to observe, not to
persist. The project list badges therefore show whatever was last observed, updated passively
whenever anyone views that project; a `NULL` `last_health_at` means the row has never been probed.

`/api/v1/projects/{ref}/health` also gained a permission guard it didn't have before —
`guardProjectRoute(read:Read, 'projects')` — so besides returning real data it now 404s an unknown
`ref` and 403s a caller with no role on the project, the same as every other per-project route in
this document.

### Edge Functions indicator hidden

The Edge Functions row on the project home's ServiceStatus panel, and its underlying query, are
both gated off (`!IS_SELF_PLATFORM`) rather than reused: upstream's check calls a hardcoded
Supabase cloud health-check URL that means nothing for a self-hosted stack. Real edge-functions
probing is deferred to M6.2. Superseded in M6.2: a 6th probe service, `edge_function`, targets
`GET {kong_url}/functions/v1/` with liveness-only semantics — Kong no-route means DISABLED, any
response under 500 means ACTIVE_HEALTHY, and ≥5xx or a timeout means UNHEALTHY. The ServiceStatus
panel row is restored in self-platform mode, now probe-backed instead of gated off; the upstream
cloud-URL check remains disabled.

Plain self-hosted mode is untouched by all of the above: `/api/v1/projects/{ref}/health` and
`/api/platform/projects/{ref}/databases-statuses` keep the M1 always-healthy stub
byte-identically, and the Edge Functions row keeps rendering as before — this milestone's
probing, write-through, and gating changes only take effect in self-platform mode.

### Upgrading an existing platform-db to M6.0

`08-health.sql` only runs automatically against an **empty** platform-db data directory, same as
every prior migration in this file. Apply it by hand once (safe to re-run — `add column if not
exists`):

```bash
docker exec -i supabase-platform-db psql -U postgres -d platform -v ON_ERROR_STOP=1 \
  < docker/volumes/platform/migrations/08-health.sql
```

## M6.1: Connection-config edit

Registry rows were write-once from Studio's point of view: created by the register CLI or the
M5.0 create form, then only editable with manual SQL on the platform-db. M6.1 adds
`PATCH /api/platform/projects/{ref}` and a "Connection configuration" panel under
Settings → General (self-platform mode) — rename, repoint connection fields, rotate secrets,
and register per-project Logflare details (the data entry point for M6.2's analytics
pipeline). There is no schema migration: M6.1 writes only columns that already exist.

### What can change, and what cannot

- `ref`, `stack_kind`, and `stack_meta` are immutable — a PATCH naming any of them is refused
  with `400` naming the field. Relabeling a row stays on the manual-SQL path documented under
  M5.0's "Stack metadata".
- A `shared-db` row (quick-created on a host stack) only accepts `name` and Logflare changes.
  Its connection fields are a clone of its host and are refused with `400`; edit the host
  project instead (the panel replaces the connection form with a pointer to the host).
- Editing the connection fields of an **external row that has shared-db children** re-syncs the
  full cloned field set (host, port, users, gateway/REST URLs, and all key ciphertexts — never
  `db_name`, `name`, or Logflare columns) onto every row whose `stack_meta.host_ref` points at
  it, and reports the affected refs in the response (`propagated_children`) and in a
  confirmation dialog before saving. The two statements are sequential, not transactional: a
  crash in between leaves the children stale, and re-sending the same PATCH heals them.
- Secrets are write-only: the API returns only configured/not-configured booleans
  (`secrets_set`), never plaintext or ciphertext. Submitting an empty value keeps the stored
  secret (the same mask round-trip as M4's auth config); submitting a new value re-encrypts
  and overwrites. The four nullable fields (`publishable key`, `secret key`, Logflare URL and
  token) can be cleared back to "not configured" by sending an explicit JSON `null` — in the
  panel, via their "Clear" checkboxes. The four required secrets (database password, anon,
  service-role, JWT) cannot be cleared, only replaced.

### Probe before save

Any PATCH that touches connection fields must pass a connectivity probe first: Studio runs
`select 1` through pg-meta against the merged candidate DSN (new values where provided, the
stored ones — password decrypted server-side — everywhere else). A failed probe returns
`400 Could not connect to database: <cause>` and writes nothing. Changes limited to `name` or
Logflare settings skip the probe. The probe covers the database channel only — a wrong gateway
URL or API key still saves, and shows up within one cache TTL as red service dots (M6.0's
health probing is the backstop). After a successful connection change the health cache entry
for the project (and for every propagated child) is dropped, so the next dashboard poll probes
the new stack immediately instead of serving up to 20 s of the old stack's results.

### RBAC

Updating requires `write:Update` on `projects` — the same action the upstream rename form
checks — which the role matrix grants to `Owner` and `Administrator` (deliberately one notch
wider than the Owner-only deregister). The upstream "rename project" form on the same settings
page uses this exact route and method, so it works in self-platform mode as of M6.1. Plain
self-hosted mode is untouched: `PATCH` answers `404 Not available on this deployment` and the
`GET` response carries no `self_platform` block.

### Env-fallback `default` isn't editable

A `default` project with no `platform.projects` row still resolves — via the M1 global-env
fallback in `resolveProjectConnection` (see "M2: multi-project registry" above) — but that
fallback has no row for a `PATCH` to update. The `write:Update` RBAC guard passes normally for
it (the guard only checks the caller's role, it doesn't know whether a row exists), but
`updateProjectConnection` (`apps/studio/lib/api/self-platform/projects-admin.ts`) throws
`ProjectRowMissing` once it finds nothing to update, and the route maps that to the same
`404 {"message": "Project not found"}` any other unknown ref gets. In practice this means both
the upstream rename form and the M6.1 Connection configuration panel fail with a 404 against an
unregistered `default` project, even though its dashboard otherwise works fine end to end.
Register the row first (`register-project register`, see "`register-project` CLI" above) to
make it editable.

## M6.2: Logflare pipeline

Since M2.1 the per-project analytics plumbing has existed on paper — `logflare_url`/
`logflare_token_enc` on `platform.projects`, the no-fallback `getAnalyticsTarget` resolver, and
the three analytics routes (see "Analytics (M2.1)" above) — but the stack-side half,
`docker-compose.logs.yml`'s Logflare + vector add-on, had never actually been deployed against
it, and the data path had never been live-verified end to end. M6.2 closes that gap and lights
up the Studio surfaces that depend on it — the home page's four usage charts, the six
observability tabs, and the per-service logs pages — for any project with a registered Logflare
(the M6.1 Connection configuration panel, or the `register-project` CLI's
`--logflare-url`/`--logflare-token` flags; see "Registering the target per project" below).

Standing the stack up turned out to be the easy part; a stock Logflare's postgres backend was
the hard part. Out of the box, `LOGFLARE_SUPABASE_MODE` seeds only two endpoints: `logs.all` (a
general-purpose sandbox-SQL endpoint) and `usage.api-counts` — and `usage.api-counts` itself
doesn't work against a postgres backend: its built-in BigQuery SQL fails BigQuery→Postgres
translation upstream (`cannot subscript type text`), the same failure a stock upstream
self-hosted deployment hits. The three other named endpoints Studio's observability tabs call —
`service-health`, `auth.metrics`, `functions.combined-stats` — were never seeded at all; an
unrecognized endpoint name gets Logflare's `401 Unauthorized`, not a 404. Rather than wait on an
upstream fix, `pages/api/platform/projects/[ref]/analytics/endpoints/[name].ts` now rewrites
exactly those four names, server-side, onto hand-written `logs.all` sandbox SQL
(`apps/studio/lib/api/self-hosted/analytics-substitutes.ts`) that queries the same underlying
service tables directly and reshapes the rows into whatever response shape each frontend hook
already expects. The rewrite applies in both self-hosted modes — these Next.js API routes never
run on cloud Studio, so cloud is untouched by construction — and only for those four names;
`logs.all` and every other endpoint name keep forwarding verbatim.

The report-chart SQL definitions that ship BigQuery dialect by default — the shared API report's
request/error/traffic/response-speed charts, the auth report's sign-in/sign-up stat charts, the
edge-functions report — gained PG-compatible variants, picked at request time by
`apps/studio/data/logs/logflare-dialect.ts`'s `pickDialect` gate
(`USE_LOGFLARE_PG_SQL = IS_SELF_PLATFORM || !IS_PLATFORM`): any real self-hosted deployment —
self-platform or plain — gets the PG-safe text, which avoids `cast(... as datetime)` (unsupported
by the translator) and uses ordinal `group by`/`order by` only, never a named alias (an alias
that happens to shadow a real column is silently mis-grouped by the translator instead of
erroring, which is why ordinals are non-negotiable here, not just a style choice). Cloud Studio
keeps the original BigQuery text byte-for-byte, unconditionally. The auth report's percentile
charts are the one exception with no PG variant at all — see "Boundaries" below.

Finally, every server-side Logflare call — the two log-retrieval helpers in
`apps/studio/lib/api/self-hosted/logs.ts` plus both log-drain routes — now carries a 15-second
`AbortSignal.timeout` (`ANALYTICS_TIMEOUT_MS`). Before M6.2 there was no timeout anywhere in this
path, so a hung Logflare left a chart or panel spinning forever; now it fails the same honest way
a *down* Logflare already did — the existing `{error:{message}}` shape — just up to 15 seconds
later instead of the ~150ms a connection refusal takes.

### Operator runbook — deploying the analytics stack

Prerequisites:

- `docker/.env` ships `LOGFLARE_PUBLIC_ACCESS_TOKEN` and `LOGFLARE_PRIVATE_ACCESS_TOKEN` with
  placeholder values (`your-super-secret-and-long-logflare-key-public`/`-private`). **Change
  them** before this port reaches anything beyond localhost — they're shared-secret bearer
  tokens (the private one is the API key every Studio request, and the verification `curl`
  below, authenticates with), not per-user credentials.
- The `_supabase` database and its `_analytics` schema — where the postgres backend stores
  everything Logflare ingests — are created automatically by the stock db init scripts
  (`docker/volumes/db/_supabase.sql`, `docker/volumes/db/logs.sql`); there is nothing to apply
  by hand.
- `DOCKER_SOCKET_LOCATION` (already set in `docker/.env`, default `/var/run/docker.sock`) must
  point at a real docker socket — `vector` mounts it read-only to tail every other container's
  logs by name.

Bring analytics and vector up with a targeted `up` — it only touches those two services, the
rest of a running stack is undisturbed:

```bash
docker compose -f docker-compose.yml -f docker-compose.platform.yml -f docker-compose.logs.yml up -d analytics vector
```

Drop the `-f docker-compose.platform.yml` on any stack that doesn't run the control plane.

`analytics`'s `4000:4000` port publish is this file's default as of M6.2 (it shipped commented
out before). Publishing it is required whenever Studio reaches Logflare from *outside* the
compose network — a host-process dev server, or any Studio that isn't itself a container on this
compose project. A Studio container running inside the same compose network can instead register
`http://analytics:4000` as the project's Logflare URL and skip the port publish entirely.

Verify the stack is actually answering:

```bash
curl -s http://localhost:4000/health
PRIV=$(grep -E '^LOGFLARE_PRIVATE_ACCESS_TOKEN=' docker/.env | cut -d= -f2)
curl -s -H "Authorization: Bearer $PRIV" "http://localhost:4000/api/endpoints/query/logs.all?project=default" | head -c 300
```

The first command should return `200`. The second authenticates the same way Studio's own
requests do and should return a JSON body with a `result` array — real rows once traffic has
flowed through Kong, an empty array on a freshly-started stack (that's expected, not an error).

### Registering the target per project

A deployed analytics stack doesn't light anything up on its own — Studio only ever queries the
Logflare target registered on a project's own row (`logflare_url`/`logflare_token_enc`; see
"Analytics (M2.1)" above for the columns and the hard NULL-means-not-configured invariant, which
M6.2 leaves unchanged). Point a project at the stack you just brought up one of two ways:

- The M6.1 panel: Settings → General → Connection configuration → Logflare URL / Logflare token
  (see "M6.1: Connection-config edit" above).
- The `register-project` CLI's `--logflare-url`/`--logflare-token` flags at register time (see
  "`register-project` CLI" above).

Either path is subject to the same `?project=default` assumption M2.1 established: Studio always
queries the target with the literal `?project=default`, never the row's own `ref`, because a
registered analytics backend is assumed to be a vanilla single-project self-hosted Logflare, and
every such instance self-identifies as `default` internally regardless of what Studio calls it.
A row with either analytics column left `NULL` still gets an honest
`404 Analytics is not configured for this project` from every analytics route — configuring the
stack changes nothing about that invariant.

### Boundaries

- **Log streams are stack-scoped, not database-scoped.** `vector` routes events by container
  name and tags every event with a single `project` value; Kong, GoTrue, and Storage events
  carry no database dimension at all. A shared-db project ("Quick create" — see "Creating a
  project" under M5.0 above) that has its own Logflare configured sees its **host stack's entire
  log stream**, not a filtered slice — there is no way to separate it further. This is exactly
  what the Connection configuration panel's shared-db hint already says ("Analytics configured
  here reads the host stack log stream — logs are stack-scoped and cannot be filtered per
  project"); M6.2 doesn't change M6.1's decision to let shared-db rows set Logflare fields
  anyway, it just documents what configuring them actually gets you.
- **Per-service ingestion depends on what each service writes to stdout, not on whether the
  pipeline is working.** PostgREST, for instance, logs nothing per-request by default — its logs
  tab renders empty even on a fully healthy, actively-queried stack. An empty tab over a quiet
  service is the honest result, not a broken one; check the service's own log verbosity before
  assuming the analytics pipeline is at fault.
- **Percentile and certain latency-ranking charts stay BigQuery-only and surface an honest chart
  error, not a flatline.** The auth report's sign-in/sign-up processing-time percentile charts
  use `approx_quantiles`, which 500s on the Logflare postgres translator with no PG equivalent
  implemented — same for the API report's "top slow routes" widget, whose entire purpose is
  ranking routes by `response.origin_time`; flatlining either would produce a fake,
  arbitrarily-ordered result, which is worse than an honest error state. Where a broken field
  only feeds a single value-over-time line instead of a ranking — the API report's
  response-speed chart, which also depends on `origin_time` — that line is zero-filled instead of
  erroring, same honest-empty precedent as the rest of this document, just a flatline instead of
  an error because nothing is actually broken about the request, only about a field the pipeline
  never populates.
- **`functions.combined-stats` and the edge functions list page's last-hour stats are both
  broken on self-hosted for the same underlying reason, but in different ways.** Neither can
  work because the self-hosted vector pipeline's `functions_logs` transform
  (`docker/volumes/logs/vector.yml`, lines 130-134 — shipped to the `logflare_functions` sink's
  `deno-relay-logs` Logflare source) never attaches a `function_id` to function log events in the
  first place. The substituted `functions.combined-stats` endpoint (above) filters on
  `function_id` inside an unnested `metadata` field, which is valid SQL that simply never
  matches any row — it returns a correctly-shaped, honestly empty result, and the same substitute
  omits the `execution_time_ms` aggregates for the identical reason (zero-filled client-side, same
  precedent as elsewhere). The edge functions list page's own last-hour-stats query
  (`apps/studio/data/edge-functions/edge-functions-last-hour-stats-query.ts`) references a bare,
  un-nested `function_id` column in its `WHERE` and per-function `GROUP BY` instead, which is not
  merely empty but 500s categorically on the Logflare postgres translator — that page surfaces
  the existing chart error state, not an empty one. Neither is a SQL-dialect problem this
  milestone's rewrites can fix; a real fix needs vector to populate `function_id` at ingestion, or
  a server-side substitution mirroring `functions.combined-stats`'s own pattern — left as a
  follow-up, out of scope for M6.2. **Superseded in M6.3:** the edge-functions list last-hour
  stats now route through a server-side substitute (honest empty — function_id is structurally
  never populated self-hosted).
- **The Unified Logs feature preview requires a BigQuery-backed Logflare and will not work
  against this stack.** Its queries lean on `UNION ALL` across service tables, which is
  categorically broken on the Logflare postgres translator (the same reason the `service-health`
  substitute above runs one query per service table instead of a single `UNION ALL` query). The
  feature is opt-in and off by default in self-hosted Studio; the per-service logs pages (Edge
  Logs, Postgres Logs, Auth Logs, and so on) are the supported, fully-working surface and are
  unaffected by any of the above.
- **Log retention and storage volume on the postgres backend are the operator's concern**, the
  same as every other piece of this stack's data (the platform-db, the project databases
  themselves): M6.2 doesn't add or change any retention policy, and running a stack indefinitely
  without pruning the `_analytics` schema will grow it indefinitely.

## M6.3: Infra metrics (sampler + vector metrics pipeline)

The Database Observability tab, the project home instance diagram's CPU/Disk/RAM/connections
rows, the realtime tab's infra half, and the resource-warnings surfaces (project cards, the
usage banner, the compute badge) were all live stubs before M6.3 — `infra-monitoring` returned an
empty series unconditionally and `projects-resource-warnings` always returned `[]` (the M6.0 D1
poller slot this milestone finally fills). M6.3 adds a resident sampler inside the Studio server
process — a 60-second loop, started from `instrumentation.ts` in self-platform mode, that walks
every registered project row regardless of its probed health status — and a matching stack-side
metrics pipeline so there is something real for it to read.

### Operator runbook: enabling host/service metrics

Metrics ride the same analytics (logs) overlay M6.2 introduced — no new containers, no new
compose file:

1. Bring the stack up with the full overlay chain (mirrors the M6.2 section above — note
   `docker-compose.platform.yml` is part of this chain on any stack running the control plane):

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.platform.yml -f docker-compose.logs.yml up -d analytics vector
   ```

   M6.3 adds to `vector`: read-only mounts of the host's `/proc` and `/sys`
   (`PROCFS_ROOT`/`SYSFS_ROOT` point vector's `host_metrics` source at them), a `9598:9598` port
   publish for its Prometheus exporter, and `METRICS_SCRAPE_TOKEN` in the compose env (defaults
   to `${ANON_KEY}` in `docker-compose.logs.yml`) — vector uses this Bearer token itself, to
   re-scrape Realtime's and Supavisor's own `/metrics` endpoints over the compose network (any
   JWT signed with the stack's JWT secret works; `ANON_KEY` already is one). The exporter vector
   itself serves on `:9598` has no authentication of its own — see the token note below.

2. Recreate vector after upgrading an existing stack onto this compose revision:

   ```bash
   docker compose -f docker-compose.yml -f docker-compose.platform.yml -f docker-compose.logs.yml up -d --force-recreate vector
   ```

3. Verify: `curl -s http://<host>:9598/metrics | grep -c '^host_'` returns a positive count
   (host CPU/memory/disk/filesystem/network series), and `realtime_`/`supavisor_` series appear
   once those services have actually handled traffic — both are activity-gated, so an idle
   service's counters simply haven't been emitted yet, not broken.

4. Register the endpoint per project: Settings → General → Connection configuration → Metrics
   URL (and the optional Metrics token), or the `register-project.ts` CLI's
   `--metrics-url`/`--metrics-token` flags (`METRICS_URL` env + `--from-current-env` also works,
   mirroring the Logflare pair). There is no auto-derived URL — point it at wherever `:9598` is
   actually reachable from the Studio process: `http://<host>:9598/metrics` for a host-network
   dev server, or `http://vector:9598/metrics` for a Studio container on the same compose network
   (the same inside/outside-network distinction the M6.2 analytics port already established). The
   Metrics token, if set, is sent as a Bearer header when Studio's own sampler scrapes that URL —
   it exists for fronting proxies an operator might put in front of vector; the stock exporter
   itself is unauthenticated on the operator's network.

### What lights up, and what honestly does not

- Database Observability tab: CPU / memory / network / disk-IO / disk-size / client-connections
  charts render from real sampled data (60-second grain, ~7-day retention — the sampler sweeps
  older rows out of `platform.metrics_samples` on an hourly-rate-limited pass). Gaps are honest:
  Studio downtime, a service's first sampling cycle, and scrape failures all leave a visible gap,
  never an interpolated or backfilled value.
- The project home instance diagram's CPU/Disk/RAM/connections rows, the realtime tab's infra
  half, and the Supavisor connections chart all read from the same sampled data (subject to
  whatever series the underlying service actually exports — see boundaries below).
- Resource warnings (project cards, the usage banner, the compute badge): cpu/memory/disk-space
  exhaustion keys are derived from each project's most recent sample (must be within the last 5
  minutes; a stale or missing sample yields an all-null warning row for that project) — `>= 90`
  is `critical`, `>= 80` is `warning`, otherwise `null`. Every other warning key
  (`disk_io_exhaustion`, the auth email/rate-limit keys, `need_pitr`) stays `null` — there is no
  usage/quota system to derive them from, and M6.3 doesn't invent one.
- Rows with no `metrics_url` registered still chart connection counts, database size, and WAL
  size — that slice comes from the platform-db's own SQL layer (`pg-meta`), which needs no
  stack-side deployment at all. Only the host-level series (CPU, memory, disk-IO, network) stay
  empty for such a row. Requesting an attribute the sampler doesn't know about returns an
  honestly-empty zeroed series, not a 404 — there is deliberately no 404 wall here, unlike the
  per-project analytics endpoints in the M6.2 section above.
- `daily-stats` remains absent — there is no route for it (billing semantics, no honest
  self-hosted source) — and any custom report block that depends on it keeps failing honestly,
  the same as before M6.3.

### Boundaries

- **Host metrics are stack-scoped, not database-scoped.** One running stack produces one host
  metrics series; every project registered against that stack's `metrics_url` — including
  shared-db children (see the M6.2 shared-db hint) — sees the identical CPU/memory/disk/network
  numbers, while its connection counts and database size stay genuinely per-database (they come
  from the SQL layer, not the scrape). On Docker Desktop and OrbStack, "the host" `host_metrics`
  actually reads is the Linux VM those tools run under, not the physical Mac — the sampler and
  vector are working correctly, they just aren't measuring what a macOS user might expect.
  **This runbook and the sampler's live verification were only exercised against that
  macOS Docker Desktop/OrbStack setup; a real Linux production host and a CI smoke-test path for
  any of the above are unexercised by this milestone.**
- **The sampler is a single Studio-server process, not a locked/coordinated one.** Running two
  Studio instances against the same platform-db would double-sample every row (harmless
  duplicate rows that bucket-averaging smooths back out, but wasted work) — dedup/locking is
  backlog, not a correctness bug in a single-instance deployment.
- **`max_cpu_usage` equals `avg_cpu_usage`** at this milestone's single-host sample grain
  (upstream's cloud chart distinguishes them across a multi-node fleet); this is documented
  behavior, not a bug masked as a flatline.
- **Realtime and Supavisor connection/channel series depend on what those services actually
  export, and are activity-gated** — a channel or connection counter genuinely reads zero until
  something has exercised it at least once since vector started scraping, same honest-empty
  precedent as the rest of this document.
- **The metrics exporter vector serves on `:9598` is plain, unauthenticated HTTP on the
  operator's own network.** `METRICS_SCRAPE_TOKEN` (defaults to `ANON_KEY`) is what vector uses
  to authenticate its own outbound scrapes of Realtime/Supavisor — it is not a gate in front of
  `:9598` itself. The per-project Metrics token field exists for an operator who fronts vector
  with their own authenticating proxy; treat network exposure of `:9598` the same as any other
  unauthenticated stack-internal port.
