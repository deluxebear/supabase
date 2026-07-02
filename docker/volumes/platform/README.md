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

**`register` with explicit flags** — for any project that isn't "the current `docker/.env`
stack", e.g. a second project. Required flags: `--ref --org --name --db-host --kong-url --db-pass
--service-key --anon-key --jwt-secret`; optional: `--db-port` (default `5432`), `--db-name`
(default `postgres`), `--db-user` (default `supabase_admin`), `--db-user-readonly`, `--rest-url`
(default `<kong-url>/rest/v1/`), `--publishable-key`, `--secret-key`. Both branches (`register`
and `--from-current-env`) are guarded against silently registering empty-secret projects — missing
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

**Still global, not yet per-project (deferred to M2.1):** Auth admin (GoTrue users/config),
Storage, Realtime, Edge Functions, Logs/Analytics, and any other pg-meta sub-resource route not
listed above (`tables`, `views`, `extensions`, etc. — only the `query` route was threaded with
`projectRef` in M2) all still talk to the single global-env project/pg-meta target regardless of
the selected project's registry row. Practically: switching to a non-default registered project
and visiting Auth/Storage/Logs will show the **default** project's data, not that project's — only
Project Overview, Settings, API Keys, and SQL Editor are genuinely project-scoped today.

**Top-priority for M2.1 — these deferred routes surface KEYS, not just data.** Most of the
still-global routes above leak the *wrong project's rows* (bad, but data-scoped). A subset instead
return **global credentials for any `ref`** — do not treat these as project-scoped, and prioritize
them first when picking up M2.1:

- `pages/api/platform/projects/[ref]/api-keys/temporary.ts` — returns the global
  `SUPABASE_SERVICE_KEY` regardless of `ref` (consumed by the Realtime Inspector).
- `pages/api/platform/props/project/[ref]/api.ts` — returns the global anon/service keys
  regardless of `ref` (consumed by Docs/API surfaces shown in the dashboard).
- `pages/api/platform/auth/[ref]/*` — GoTrue admin config/users for the global project only.
- `pages/api/platform/projects/[ref]/config/*` — project config (Postgres, auth, storage, etc.)
  for the global project only.
- `pages/api/platform/projects/[ref]/api/rest.ts` and `.../api/graphql.ts` — global
  PostgREST/pg-graphql surfaces.

Visiting any of these for a non-default registered project today silently hands back the
**default** project's secrets under that other project's `ref` — a real cross-project credential
leak risk in a multi-project deployment, not just a UI data-mismatch. This finding is doc-only
here (plan-scoped to M2.1); no code fix shipped in M2.

**Also not project-scoped (pre-existing, unrelated to the registry):** SQL Editor's saved
snippets (`SNIPPETS_MANAGEMENT_FOLDER`, on-disk) are a single shared folder read by every project
— the same snippet list appears in every registered project's SQL Editor sidebar. Query
*execution* is correctly routed per-project (see above); the snippet *list/metadata* is not.

### Known limitations (M2)

- **Pagination is not yet sliced.** `listAllProjectsV2` and the org-projects route accept
  `limit`/`offset` query params and echo them back in the `pagination` envelope, but the
  underlying registry read is not actually paginated at the SQL level — both routes currently
  return every registered project regardless of `limit`/`offset`. Fine at current scale
  (single-digit projects); would need a real `LIMIT`/`OFFSET` (or keyset) query before this
  registry is used with a large number of projects.
- **No re-encryption/key-rotation tooling** for `PLATFORM_ENCRYPTION_KEY` (see above).
- **The CLI has no `update`-only or `rotate-secret` command** — re-running `register` with the
  same `--ref` upserts (all columns overwritten), which is fine for re-registering but has no
  narrower "just change one field" affordance.
