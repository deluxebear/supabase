# Self-platform all-in-one compose — design

Date: 2026-07-10 · Status: approved (user decisions recorded below) · Milestone: SP-C1

## Goal

A new, self-contained compose distribution at `docker/self-platform/` that runs the full
default Supabase stack **plus** the self-platform management plane in one compose project,
with:

- **one shared Postgres**: the platform control-plane data moves out of the standalone
  `platform-db` container into a dedicated `_platform` database inside `supabase-db`
  (mirroring the existing `_supabase` database pattern for `_analytics`/`_supavisor`);
- **multi-account dashboard login replacing Kong basic-auth**: the Kong dashboard route
  loses its `basic-auth` plugin; access control is the plt-studio login gate
  (M1 default-deny `apiWrapper` + platform GoTrue sessions + M3 RBAC + M3.2 invite-only
  signup + MFA enforcement) — all of which already ships in `deluxebear/supabase-plt-studio`.

**Zero Studio source changes** except one backward-compatible CLI tweak (Task 5 in the plan):
`register-project.ts` gains `PLATFORM_DB_USER`/`PLATFORM_DB_NAME` env overrides (defaults
`postgres`/`platform` keep the mini-stack flow byte-identical).

## User decisions (2026-07-10)

1. **Form**: standalone directory `docker/self-platform/` (own compose + kong config + env +
   README). `docker/docker-compose.yml` and `docker/volumes/api/kong.yml` stay untouched
   (upstream-sync hygiene). `docker/docker-compose.platform.yml` (mini-stack) stays as-is and
   keeps working.
2. **Platform GoTrue exposure**: Kong route `/platform-auth/v1` → `platform-auth:9999`
   (same topology as the project GoTrue behind `/auth/v1`). No extra host port.
3. **Process**: spec + plan first, then SDD execution.

## Topology

```
docker/self-platform/docker-compose.yml   (compose project: supabase-plt)
├── db (supabase-db, deluxebear/postgres:17)
│     ├── postgres      ← project data (unchanged)
│     ├── _supabase     ← _analytics/_supavisor (unchanged)
│     └── _platform     ← NEW: platform.* registry + platform GoTrue's auth.* schema
├── platform-auth (gotrue v2.189.0)  → db/_platform          [no host port; behind Kong]
├── platform-mail (mailpit)          → invite/recovery email  [localhost-bound UI/SMTP ports]
├── studio (deluxebear/supabase-plt-studio) → db/_platform + platform-auth + meta
├── kong (kong-plt.yml: dashboard route WITHOUT basic-auth, + /platform-auth/v1 route)
├── auth/rest/realtime/storage/imgproxy/meta/functions/supavisor  (byte-copied from upstream compose)
└── [profile: obs] analytics (logflare) + vector + cadvisor       (from docker-compose.logs.yml)
```

Browser flow: `SUPABASE_PUBLIC_URL` (Kong) → `/` studio login page → `/platform-auth/v1/*`
platform GoTrue (session) → all `/api/platform/*` default-deny, session + RBAC enforced.
Data-plane routes (`/auth/v1`, `/rest/v1`, `/storage/v1`, `/realtime/v1`) keep key-auth —
removing dashboard basic-auth does not touch them.

## Directory layout

```
docker/self-platform/
├── docker-compose.yml            # complete stack (all services), profiles: obs
├── .env.example                  # superset of docker/.env.example + PLATFORM_* block, minus DASHBOARD_*
├── README.md                     # quickstart, bootstrap, migration from mini-stack, obs, TLS
├── volumes/
│   ├── api/kong-plt.yml          # kong.yml minus basic-auth/DASHBOARD consumer, plus platform-auth route
│   └── db/
│       ├── _platform.sql         # role platform_admin + database _platform (initdb)
│       └── platform-migrations.sql  # \c _platform; set role; \i /platform-migrations/01..11
└── scripts/
    └── bootstrap.sh              # idempotent: existing-volume init + first admin + register default project
```

Immutable config is referenced from the parent (`../volumes/db/*.sql`,
`../volumes/api/kong-entrypoint.sh`, `../volumes/logs/vector.yml`, `../volumes/pooler/pooler.exs`,
`../volumes/platform/migrations/`). Mutable state is local (`./volumes/db/data`,
`./volumes/storage`, `./volumes/snippets`, `./volumes/functions`) so the new stack gets a fresh
initdb and never collides with `docker/volumes/db/data`.

## Key design points

### D1 — `_platform` database in the shared cluster

- `volumes/db/_platform.sql` (mounted as `/docker-entrypoint-initdb.d/migrations/97-_platform.sql`):
  creates login role `platform_admin` (password `${PLATFORM_POSTGRES_PASSWORD}`, read from env
  via psql `\set` backtick, same idiom as `_supabase.sql`), `CREATE DATABASE _platform OWNER
platform_admin`, and `ALTER ROLE platform_admin IN DATABASE _platform SET search_path =
public, auth` — the M1 Task-4 lesson: GoTrue lookups must fall through to `auth`.
- `volumes/db/platform-migrations.sql` (mounted as `.../migrations/98-platform-migrations.sql`):
  `\c _platform`, `set role platform_admin`, then `\i /platform-migrations/NN-*.sql` for all 11
  platform migrations, `reset role`, `\c postgres`. The migrations dir is mounted at
  **`/platform-migrations`, deliberately OUTSIDE `/docker-entrypoint-initdb.d`** so the image
  entrypoint cannot auto-execute them against the wrong database; only the wrapper reaches them
  via absolute `\i` paths.
- Platform GoTrue runs its own migrations into `_platform`'s `auth` schema at startup —
  schema-per-database means zero collision with the project's `auth` schema.
- The `db` service gains the `PLATFORM_POSTGRES_PASSWORD` env (needed by the `\set` backtick).

### D2 — initdb runs once; `bootstrap.sh` covers everything else

`docker-entrypoint-initdb.d` only executes on a fresh `PGDATA`. `scripts/bootstrap.sh` is the
single idempotent host-side entry point (docker + psql-in-container + curl + openssl only — no
node dependency at deploy time), three phases:

1. **`_platform` init (existing volumes)**: if `pg_database` lacks `_platform`, create role/db
   and stream each migration file into `docker exec -i supabase-db psql -d _platform`.
   Skipped entirely on fresh volumes (initdb already did it).
2. **First admin**: mint a 60 s HS256 `service_role` JWT from `PLATFORM_JWT_SECRET` (openssl
   HMAC), `POST {SUPABASE_PUBLIC_URL}/platform-auth/v1/admin/users` with
   `{email, password, email_confirm:true}` from `PLATFORM_ADMIN_EMAIL`/`PLATFORM_ADMIN_PASSWORD`
   (409/422 "already exists" tolerated), then password-grant login, then
   `GET {SUPABASE_PUBLIC_URL}/api/platform/profile` with the user token — Studio auto-creates
   the `platform.profiles` row + default-org membership on first profile fetch (M1 behavior) —
   then the Owner grant:
   `insert into platform.member_roles (profile_id, role_id) select pr.id, 1 from
platform.profiles pr where pr.primary_email = $EMAIL on conflict do nothing;`
3. **Register the default project**: upsert into `platform.projects` (same statement as
   `buildUpsertSql()` in `docker/scripts/platform/register-project.ts`) with values from `.env`:
   `ref=default, org=default, db_host=db, kong_url=${SUPABASE_PUBLIC_URL},
stack_kind=external, container_name=supabase-db`; secrets AES-encrypted with
   `openssl enc -aes-256-cbc -md md5 -base64 -A -pass pass:$PLATFORM_ENCRYPTION_KEY`
   (OpenSSL EVP "Salted\_\_" format — what crypto-js `AES.encrypt(str, passphrase)` produces and
   what `lib/api/self-platform/secrets.ts` decrypts; the plan verifies this compatibility with a
   crypto-js round-trip test before relying on it). When the `obs` profile is up, also register
   `logflare_url=http://analytics:4000` (+ encrypted token) and `metrics_url=http://vector:9598`.

### D3 — Kong config `kong-plt.yml`

Copy of `docker/volumes/api/kong.yml` with exactly three edits:

1. Remove the `DASHBOARD` consumer and the whole `basicauth_credentials` block.
2. Remove the `basic-auth` plugin from the `dashboard` route (keep `cors`).
3. Add one service ahead of the dashboard catch-all:
   `platform-auth-v1: url http://platform-auth:9999/, route path /platform-auth/v1,
strip_path: true, plugins: [cors]` — GoTrue does its own auth; no key-auth, no ACL
   (identical posture to the open `/auth/v1/verify` routes).

`DASHBOARD_USERNAME`/`DASHBOARD_PASSWORD` disappear from the env contract;
`kong-entrypoint.sh` is reused unchanged (its sed placeholders simply no-op when the
placeholder strings are absent from the file).

### D4 — studio service (plt image) env matrix

| Env                                              | Value                                                                                        | Why                                                                                                                                                                                                       |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| image                                            | `deluxebear/supabase-plt-studio:latest`                                                      | platform build                                                                                                                                                                                            |
| `NEXT_PUBLIC_SELF_PLATFORM`                      | `"true"`                                                                                     | server-side runtime reads (`instrumentation.ts` sampler boot)                                                                                                                                             |
| `PLATFORM_POSTGRES_HOST/PORT/DB/USER/PASSWORD`   | `db` / `${POSTGRES_PORT}` / `_platform` / `platform_admin` / `${PLATFORM_POSTGRES_PASSWORD}` | control-plane DB now in shared cluster                                                                                                                                                                    |
| `PLATFORM_PG_META_URL`                           | `http://meta:8080`                                                                           | **platform mode reads `PLATFORM_PG_META_URL`, not `STUDIO_PG_META_URL`** (`lib/constants/index.ts:42`); unset = every pg-meta call breaks                                                                 |
| `PLATFORM_GOTRUE_URL`                            | `http://platform-auth:9999`                                                                  | server-side (invite emails, admin calls) — direct, no Kong hop                                                                                                                                            |
| `PLATFORM_JWT_SECRET`, `PLATFORM_ENCRYPTION_KEY` | from `.env`                                                                                  | session verification / registry secret decryption                                                                                                                                                         |
| `PLATFORM_SITE_URL`                              | `${SUPABASE_PUBLIC_URL}`                                                                     | invite redirect target = studio public origin (Kong)                                                                                                                                                      |
| `NEXT_PUBLIC_API_URL`                            | `${SUPABASE_PUBLIC_URL}/api`                                                                 | runtime placeholder sed (`docker-entrypoint.sh`)                                                                                                                                                          |
| `NEXT_PUBLIC_GOTRUE_URL`                         | `${SUPABASE_PUBLIC_URL}/platform-auth/v1`                                                    | runtime placeholder sed; browser reaches GoTrue via Kong                                                                                                                                                  |
| healthcheck                                      | `GET /api/platform/telemetry/feature-flags` expect 200                                       | **the upstream healthcheck path `/api/platform/profile` 401s under self-platform default-deny.** Only `signup.ts` and `telemetry/feature-flags.ts` are `withAuth: false`; feature-flags is the stable 200 |
| `depends_on`                                     | `platform-auth: service_healthy` (upstream studio has none)                                  | login must be possible when Kong reports the stack up (kong depends on studio-healthy)                                                                                                                    |

All other upstream studio env lines are kept verbatim (global-fallback paths still read them).

### D5 — platform-auth / platform-mail

`platform-auth` is the mini-stack service with: `GOTRUE_DB_DATABASE_URL:
postgres://platform_admin:${PLATFORM_POSTGRES_PASSWORD}@db:${POSTGRES_PORT}/_platform`,
`API_EXTERNAL_URL: ${SUPABASE_PUBLIC_URL}/platform-auth/v1`, `GOTRUE_SITE_URL:
${SUPABASE_PUBLIC_URL}`, `GOTRUE_URI_ALLOW_LIST: ${SUPABASE_PUBLIC_URL}/**`,
`depends_on: db: service_healthy`, **no host ports**. Everything else (invite-only signup,
JWT settings, the Mailpit SMTP empty-credentials deviation and its rationale comment) is
carried over verbatim. `platform-mail` is carried over unchanged (localhost-bound ports).

### D6 — observability profile

`analytics`, `vector`, `cadvisor` are copied from `docker-compose.logs.yml` (which already
carries the fork's M6.3/M6.4 changes) under `profiles: ["obs"]`. Studio's
`ENABLED_FEATURES_LOGS_ALL` becomes `${ENABLED_FEATURES_LOGS_ALL:-false}` (set `true` in `.env`
when running the profile). Self-platform reads Logflare/metrics per-ref from the registry, so
`bootstrap.sh` phase 3 is what actually lights the charts up. Without the profile everything
degrades honestly (empty logs/metrics), by design.

### D7 — container names & coexistence

Container names stay `supabase-db`, `supabase-kong`, etc. (compose project name
`supabase-plt`). Rationale: `vector.yml` log scraping, `container_name`-based metrics, and
`bootstrap.sh`'s `docker exec supabase-db` all key off those names. Consequence — **this stack
and the plain `docker/` stack are mutually exclusive on one host** (container names + host
ports collide). Documented in README.

## Security posture

- Dashboard: unauthenticated users get the login page only; every `/api/platform/*` route is
  default-deny (M1 C1 fix), RBAC-scoped (M3.0/M3.1), invite-only registration (M3.2), MFA
  enforceable per org. This strictly dominates the single shared basic-auth password it replaces.
- Data plane: Kong key-auth/ACL on `/auth/v1`, `/rest/v1`, `/storage/v1`, `/realtime/v1`
  byte-identical to upstream.
- Secrets in `.env`: `PLATFORM_JWT_SECRET` (≥32 chars), `PLATFORM_ENCRYPTION_KEY`,
  `PLATFORM_POSTGRES_PASSWORD`, `PLATFORM_ADMIN_PASSWORD` — `.env.example` ships placeholder
  text (not working demo values) for the platform block, and README repeats the upstream
  warning that the inherited demo `JWT_SECRET`/`POSTGRES_PASSWORD` values must be rotated.
- TLS: terminate at Kong (`KONG_SSL_CERT` comments preserved) or an outer reverse proxy;
  single public origin means one certificate covers studio + platform GoTrue + data plane.

## Risks

| Risk                                                                       | Mitigation                                                                                                                                                            |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| initdb-once: existing volumes never get `_platform`                        | `bootstrap.sh` phase 1 is idempotent and detects/creates; README makes it a mandatory quickstart step                                                                 |
| entrypoint auto-executing platform migrations against the wrong DB         | migrations mounted **outside** `/docker-entrypoint-initdb.d` (`/platform-migrations`), reached only via `\i`                                                          |
| openssl↔crypto-js AES incompatibility silently corrupting registry secrets | plan Task 4 step 1 proves round-trip with the repo's own crypto-js before the script is written; E2E G3 exercises live decryption (SQL editor query via registry DSN) |
| studio healthcheck red under default-deny                                  | switch to `telemetry/feature-flags` (verified `withAuth: false`)                                                                                                      |
| shared cluster = shared blast radius (db down ⇒ management login down too) | accepted trade-off (user decision); README states it; pgBackRest whole-cluster backups now cover `_platform` too (registry restored with the data)                    |
| `search_path` regression for GoTrue in `_platform`                         | `ALTER ROLE ... IN DATABASE _platform SET search_path = public, auth` in `_platform.sql`; E2E G2 (login) fails loudly if wrong                                        |
| running both stacks at once                                                | identical container names make the collision immediate and obvious; README documents mutual exclusivity                                                               |

## Acceptance gates (E2E, plan Task 7)

- **G1 fresh boot**: `cp .env.example .env` + secrets → `docker compose up -d` → all services
  healthy, `_platform` present with 11 migrations applied, studio healthcheck green.
- **G2 bootstrap + login**: `scripts/bootstrap.sh` (twice — second run must be a no-op) →
  browser to `${SUPABASE_PUBLIC_URL}` gets the studio login page **with no basic-auth prompt**
  → first admin logs in → lands on the default org.
- **G3 manage the default project**: project visible; SQL editor runs a query (proves registry
  DSN decryption); Auth users page lists project users; Storage buckets list; backups page
  shows observe-only state.
- **G4 multi-account**: invite a second user from the members UI → Mailpit link → accept →
  second account logs in with role-limited access (Read-only role cannot run DDL).
- **G5 obs profile**: `--profile obs` up + re-run bootstrap phase 3 → Log Explorer returns
  rows; infra metrics charts render container data.
- **G6 auth boundary**: `curl -I ${SUPABASE_PUBLIC_URL}/` → 200/302 (no `WWW-Authenticate`);
  `curl ${SUPABASE_PUBLIC_URL}/rest/v1/ → 401` without apikey (data-plane gate intact);
  `curl ${SUPABASE_PUBLIC_URL}/api/platform/projects → 401` without session (default-deny intact).

## Out of scope

- k8s variant of this all-in-one (the `docker/k8s/single-project/` deploy stays data-plane-only).
- Any change to child-project provisioning (shared-db quick-create) semantics.
- Removing/deprecating the mini-stack (`docker-compose.platform.yml`) — it remains the
  dev-server workflow; README cross-references only.
- The feature-flag sweep for unimplemented cloud features (separate milestone candidate).
