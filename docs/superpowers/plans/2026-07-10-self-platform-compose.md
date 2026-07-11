# Self-platform All-in-one Compose Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `docker/self-platform/` — a self-contained compose distribution running the full default Supabase stack plus the self-platform management plane in one compose project, with the control-plane data in a `_platform` database inside the shared `supabase-db` cluster, and multi-account GoTrue dashboard login replacing Kong basic-auth.

**Architecture:** New standalone directory; upstream `docker/docker-compose.yml` / `volumes/api/kong.yml` untouched. `_platform` DB mirrors the `_supabase` initdb pattern; `platform-auth` (GoTrue) points at it; Kong gains a `/platform-auth/v1` route and loses dashboard basic-auth; `scripts/bootstrap.sh` idempotently covers existing-volume init, first-admin creation, and default-project registration. Spec: `docs/self-hosted-parity/2026-07-10-self-platform-compose-design.md`.

**Tech Stack:** Docker Compose, Kong 3.9 declarative config, psql initdb scripts, POSIX-ish bash (docker + curl + openssl only), one small TypeScript CLI tweak (vitest-tested).

## Global Constraints

- Do NOT modify: `docker/docker-compose.yml`, `docker/docker-compose.platform.yml`, `docker/volumes/api/kong.yml`, anything under `apps/studio/` — **except** `docker/scripts/platform/register-project.ts` + its test (Task 5 only).
- All new docs/comments in U.S. English. Mark fork-specific additions with `[self-platform]` comments, matching existing convention.
- Every new/changed file lives under `docker/self-platform/` except Task 5.
- Images: `deluxebear/supabase-plt-studio:latest`, `deluxebear/postgres:17`, `supabase/gotrue:v2.189.0`, `kong/kong:3.9.1`, `axllent/mailpit:v1.20` — same tags as the sources being copied.
- Container names stay identical to the upstream stack (`supabase-db`, `supabase-kong`, …); compose project name is `supabase-plt`. The two stacks are mutually exclusive on one host (documented in Task 6).
- `bootstrap.sh` must pass `shellcheck` and `bash -n`; must be safe to run twice (idempotent).
- Studio healthcheck endpoint is `GET /api/platform/telemetry/feature-flags` (the only stable `withAuth: false` 200 under self-platform default-deny — verified: only `signup.ts` and `telemetry/feature-flags.ts` pass `withAuth: false`).
- Branch: `feat/self-platform-compose` off `custom/main`. Conventional commits.

---

### Task 1: `_platform` initdb SQL

**Files:**

- Create: `docker/self-platform/volumes/db/_platform.sql`
- Create: `docker/self-platform/volumes/db/platform-migrations.sql`

**Interfaces:**

- Consumes: `docker/volumes/platform/migrations/01..11-*.sql` (existing, read-only), env `PLATFORM_POSTGRES_PASSWORD` + `POSTGRES_USER` inside the db container.
- Produces: role `platform_admin` (login), database `_platform` owned by it with `search_path = public, auth`, all 11 platform migrations applied. Task 3 mounts these two files as `/docker-entrypoint-initdb.d/migrations/97-_platform.sql` and `98-platform-migrations.sql`, and the migrations dir at `/platform-migrations`. Task 4's phase 1 replicates the same end state for pre-existing volumes.

- [ ] **Step 1: Write `_platform.sql`**

```sql
-- [self-platform] Control-plane database inside the shared cluster.
-- Mirrors ../../../volumes/db/_supabase.sql (the `_supabase` pattern).
-- Runs only on a fresh PGDATA via docker-entrypoint-initdb.d; existing
-- volumes are handled by scripts/bootstrap.sh phase 1.
\set platform_pass `echo "$PLATFORM_POSTGRES_PASSWORD"`

create role platform_admin login password :'platform_pass';
create database _platform with owner platform_admin;
-- GoTrue DDL defaults to public; unqualified lookups must fall through to
-- auth (M1 Task-4 lesson — see docker/volumes/platform/migrations/01-schema.sql).
alter role platform_admin in database _platform set search_path = public, auth;
```

- [ ] **Step 2: Write `platform-migrations.sql`**

```sql
-- [self-platform] Apply the platform control-plane migrations into _platform.
-- The migration files are mounted at /platform-migrations — deliberately
-- OUTSIDE /docker-entrypoint-initdb.d so the image entrypoint can never
-- auto-run them against the wrong database; this wrapper is the only executor.
-- Order matches lexical initdb order of the standalone platform-db mini-stack.
\c _platform
set role platform_admin;
\i /platform-migrations/01-schema.sql
\i /platform-migrations/02-projects.sql
\i /platform-migrations/03-analytics.sql
\i /platform-migrations/04-roles.sql
\i /platform-migrations/05-invitations.sql
\i /platform-migrations/05-mfa-enforcement.sql
\i /platform-migrations/06-auth-config.sql
\i /platform-migrations/07-stack-metadata.sql
\i /platform-migrations/08-health.sql
\i /platform-migrations/09-metrics.sql
\i /platform-migrations/10-container.sql
\i /platform-migrations/11-k8s-identity.sql
reset role;
\c postgres
```

(Pre-verified: `grep -in "create extension\|owner to\|superuser\|grant " docker/volumes/platform/migrations/*.sql` finds no superuser-only statements — plain SQL, safe under `set role platform_admin`.)

- [ ] **Step 3: Run a throwaway initdb against the real image and verify**

```bash
cd docker
docker run --rm -d --name plt-initdb-test \
  -e POSTGRES_PASSWORD=test-pg-pass -e PLATFORM_POSTGRES_PASSWORD=test-plt-pass \
  -e POSTGRES_DB=postgres -e PGPORT=5432 -e JWT_SECRET=x -e JWT_EXP=3600 \
  -v "$PWD/self-platform/volumes/db/_platform.sql":/docker-entrypoint-initdb.d/migrations/97-_platform.sql:ro \
  -v "$PWD/self-platform/volumes/db/platform-migrations.sql":/docker-entrypoint-initdb.d/migrations/98-platform-migrations.sql:ro \
  -v "$PWD/volumes/platform/migrations":/platform-migrations:ro \
  deluxebear/postgres:17
sleep 25
docker exec plt-initdb-test psql -U supabase_admin -tAc \
  "select 1 from pg_roles where rolname='platform_admin'"
docker exec plt-initdb-test psql -U supabase_admin -d _platform -tAc \
  "select count(*) from platform.projects; select count(*) from platform.organizations;"
docker exec plt-initdb-test psql -U supabase_admin -tAc \
  "select setconfig from pg_db_role_setting s join pg_roles r on r.oid=s.setrole where r.rolname='platform_admin';"
docker rm -f plt-initdb-test
```

Expected: role query prints `1`; `platform.projects` count `0` (relation exists), `platform.organizations` count `1` (seed default org from `01-schema.sql`); setconfig contains `search_path=public, auth`. If any migration errors under `set role`, the container log shows it — fix by adding the minimal grant to `_platform.sql` (not by editing the shared migrations).

- [ ] **Step 4: Commit**

```bash
git add docker/self-platform/volumes/db/
git commit -m "feat(self-platform): _platform initdb SQL for the shared-cluster compose"
```

---

### Task 2: Kong declarative config `kong-plt.yml`

**Files:**

- Create: `docker/self-platform/volumes/api/kong-plt.yml` (derived from `docker/volumes/api/kong.yml`)

**Interfaces:**

- Consumes: `docker/volumes/api/kong.yml` (copy base), service DNS name `platform-auth`.
- Produces: dashboard route without basic-auth; new route `/platform-auth/v1` → `http://platform-auth:9999/`. Task 3 mounts this file at `/home/kong/temp.yml` (reusing `../volumes/api/kong-entrypoint.sh` unchanged — its sed placeholders no-op when absent from the file).

- [ ] **Step 1: Copy the base**

```bash
cp docker/volumes/api/kong.yml docker/self-platform/volumes/api/kong-plt.yml
```

- [ ] **Step 2: Remove the DASHBOARD consumer and basic-auth credentials**

Delete these two blocks (top of file):

```yaml
- username: DASHBOARD
```

```yaml
###
### Dashboard credentials
###
basicauth_credentials:
  - consumer: DASHBOARD
    username: '$DASHBOARD_USERNAME'
    password: '$DASHBOARD_PASSWORD'
```

- [ ] **Step 3: Strip basic-auth from the dashboard route**

At the bottom (`## Protected Dashboard - catch all remaining routes`), change the dashboard service's plugin list from:

```yaml
plugins:
  - name: cors
  - name: basic-auth
    config:
      hide_credentials: true
```

to:

```yaml
# [self-platform] basic-auth removed: access control is the plt-studio
# login gate (platform GoTrue sessions + default-deny API + RBAC).
plugins:
  - name: cors
```

- [ ] **Step 4: Add the platform GoTrue route**

Insert immediately BEFORE the `## Protected Dashboard - catch all remaining routes` comment:

```yaml
## [self-platform] Platform GoTrue (dashboard operator accounts).
## No key-auth/ACL: GoTrue authenticates its own requests — same posture
## as the open /auth/v1/verify routes above.
- name: platform-auth-v1
  _comment: 'Platform GoTrue: /platform-auth/v1/* -> http://platform-auth:9999/*'
  url: http://platform-auth:9999/
  routes:
    - name: platform-auth-v1-all
      strip_path: true
      paths:
        - /platform-auth/v1
  plugins:
    - name: cors
```

- [ ] **Step 5: Validate with the real Kong image**

```bash
sed -e 's/\$SUPABASE_ANON_KEY/dummy-anon/g' \
    -e 's/\$SUPABASE_SERVICE_KEY/dummy-service/g' \
    -e 's/\$SUPABASE_PUBLISHABLE_KEY/dummy-pub/g' \
    -e 's/\$SUPABASE_SECRET_KEY/dummy-sec/g' \
    -e 's/\$ANON_KEY_ASYMMETRIC//g' -e 's/\$SERVICE_ROLE_KEY_ASYMMETRIC//g' \
    docker/self-platform/volumes/api/kong-plt.yml > /tmp/kong-plt-test.yml
docker run --rm -v /tmp/kong-plt-test.yml:/tmp/kong.yml:ro \
  -e KONG_DATABASE=off kong/kong:3.9.1 kong config parse /tmp/kong.yml
```

Expected: `parse successful`. Also assert the removals stuck:

```bash
grep -c "basic-auth\|DASHBOARD" docker/self-platform/volumes/api/kong-plt.yml
```

Expected: `0`.

- [ ] **Step 6: Commit**

```bash
git add docker/self-platform/volumes/api/kong-plt.yml
git commit -m "feat(self-platform): kong config without dashboard basic-auth, + /platform-auth/v1 route"
```

---

### Task 3: The compose file + `.env.example`

**Files:**

- Create: `docker/self-platform/docker-compose.yml`
- Create: `docker/self-platform/.env.example`

**Interfaces:**

- Consumes: Task 1 SQL (db mounts), Task 2 kong config, `../volumes/*` shared config, `deluxebear/supabase-plt-studio` runtime placeholders (`NEXT_PUBLIC_API_URL`, `NEXT_PUBLIC_GOTRUE_URL` — see `apps/studio/docker-entrypoint.sh`).
- Produces: compose project `supabase-plt`; services `studio kong auth rest realtime storage imgproxy meta functions db supavisor platform-auth platform-mail` + `analytics vector cadvisor` under `profiles: ["obs"]`. Task 4 and Task 7 run against it.

- [ ] **Step 1: Write `docker-compose.yml`**

Header + copy policy: every service NOT listed below is **byte-copied** from `docker/docker-compose.yml` (same tags, env, healthchecks): `auth` (:122-260), `rest` (:262-296), `realtime` (:298-342), `storage` (:345-406), `imgproxy` (:408-429), `meta` (:431-446), `functions` (:448-486), `supavisor` (:545-596), plus the trailing `volumes:` block (`db-config`, `deno-cache`). The `analytics`, `vector`, `cadvisor` services are byte-copied from `docker/docker-compose.logs.yml` (:19-124). Apply exactly these mount-path rewrites to copied services (mutable state stays local `./volumes/…`, shared immutable config goes up one level `../volumes/…`):

| Service           | Upstream mount                | New mount                                             |
| ----------------- | ----------------------------- | ----------------------------------------------------- |
| supavisor         | `./volumes/pooler/pooler.exs` | `../volumes/pooler/pooler.exs`                        |
| vector            | `./volumes/logs/vector.yml`   | `../volumes/logs/vector.yml`                          |
| storage, imgproxy | `./volumes/storage`           | `./volumes/storage` (unchanged literal — local dir)   |
| functions         | `./volumes/functions`         | `./volumes/functions` (unchanged literal — local dir) |

And add `profiles: ["obs"]` as the first key of each of `analytics`, `vector`, `cadvisor`.

File skeleton with the fully-specified services (write this content, splicing the byte-copied services where marked):

```yaml
# [self-platform] All-in-one self-platform stack: the full default Supabase
# stack plus the management control plane (platform GoTrue + _platform DB in
# the shared supabase-db cluster) in ONE compose project. Dashboard access is
# multi-account GoTrue login (invite-only + RBAC) — Kong basic-auth removed.
#
# Usage:
#   cp .env.example .env   # then rotate every secret (see README)
#   docker compose up -d
#   ./scripts/bootstrap.sh # idempotent: _platform init + first admin + register default project
#   docker compose --profile obs up -d   # optional: logs + infra metrics
#
# NOTE: container names are identical to the plain docker/ stack — the two
# stacks cannot run simultaneously on one host.

name: supabase-plt

services:
  studio:
    container_name: supabase-studio
    image: deluxebear/supabase-plt-studio:latest
    restart: unless-stopped
    healthcheck:
      test: [
          'CMD-SHELL',
          # [self-platform] /api/platform/profile 401s under default-deny;
          # telemetry/feature-flags is the stable withAuth:false 200.
          'node -e "fetch(''http://localhost:3000/api/platform/telemetry/feature-flags'').then((r) => {if (r.status !== 200) throw new Error(r.status)})"',
        ]
      timeout: 10s
      interval: 5s
      retries: 3
      start_period: 20s
    depends_on:
      db:
        condition: service_healthy
      platform-auth:
        condition: service_healthy
    environment:
      HOSTNAME: '0.0.0.0'

      # --- upstream studio env, kept verbatim ---
      STUDIO_PG_META_URL: http://meta:8080
      POSTGRES_PORT: ${POSTGRES_PORT}
      POSTGRES_HOST: ${POSTGRES_HOST}
      POSTGRES_DB: ${POSTGRES_DB}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_USER_READ_WRITE: postgres
      PG_META_CRYPTO_KEY: ${PG_META_CRYPTO_KEY}
      PGRST_DB_SCHEMAS: ${PGRST_DB_SCHEMAS}
      PGRST_DB_MAX_ROWS: ${PGRST_DB_MAX_ROWS:-1000}
      PGRST_DB_EXTRA_SEARCH_PATH: ${PGRST_DB_EXTRA_SEARCH_PATH:-public}
      DEFAULT_ORGANIZATION_NAME: ${STUDIO_DEFAULT_ORGANIZATION}
      DEFAULT_PROJECT_NAME: ${STUDIO_DEFAULT_PROJECT}
      OPENAI_API_KEY: ${OPENAI_API_KEY}
      SUPABASE_URL: http://kong:8000
      SUPABASE_PUBLIC_URL: ${SUPABASE_PUBLIC_URL}
      SUPABASE_ANON_KEY: ${ANON_KEY}
      SUPABASE_SERVICE_KEY: ${SERVICE_ROLE_KEY}
      AUTH_JWT_SECRET: ${JWT_SECRET}
      SUPABASE_PUBLISHABLE_KEY: ${SUPABASE_PUBLISHABLE_KEY}
      SUPABASE_SECRET_KEY: ${SUPABASE_SECRET_KEY}
      ENABLED_FEATURES_LOGS_ALL: ${ENABLED_FEATURES_LOGS_ALL:-false}
      ENABLED_FEATURES_AUTHENTICATION_THIRD_PARTY_AUTH: 'false'
      SNIPPETS_MANAGEMENT_FOLDER: /app/snippets
      EDGE_FUNCTIONS_MANAGEMENT_FOLDER: /app/edge-functions

      # --- [self-platform] control-plane wiring ---
      NEXT_PUBLIC_SELF_PLATFORM: 'true'
      PLATFORM_POSTGRES_HOST: db
      PLATFORM_POSTGRES_PORT: ${POSTGRES_PORT}
      PLATFORM_POSTGRES_DB: _platform
      PLATFORM_POSTGRES_USER: platform_admin
      PLATFORM_POSTGRES_PASSWORD: ${PLATFORM_POSTGRES_PASSWORD}
      # Platform mode reads PLATFORM_PG_META_URL (not STUDIO_PG_META_URL) —
      # apps/studio/lib/constants/index.ts:42.
      PLATFORM_PG_META_URL: http://meta:8080
      PLATFORM_GOTRUE_URL: http://platform-auth:9999
      PLATFORM_JWT_SECRET: ${PLATFORM_JWT_SECRET}
      PLATFORM_ENCRYPTION_KEY: ${PLATFORM_ENCRYPTION_KEY}
      PLATFORM_SITE_URL: ${SUPABASE_PUBLIC_URL}
      # Runtime NEXT_PUBLIC_* placeholders (apps/studio/docker-entrypoint.sh)
      NEXT_PUBLIC_API_URL: ${SUPABASE_PUBLIC_URL}/api
      NEXT_PUBLIC_GOTRUE_URL: ${SUPABASE_PUBLIC_URL}/platform-auth/v1
    volumes:
      - ./volumes/snippets:/app/snippets:z
      - ./volumes/functions:/app/edge-functions:ro,z

  kong:
    container_name: supabase-kong
    image: kong/kong:3.9.1
    restart: unless-stopped
    networks:
      default:
        aliases:
          - api-gw
    healthcheck:
      test: ['CMD', 'kong', 'health']
      interval: 5s
      timeout: 5s
      retries: 5
    depends_on:
      studio:
        condition: service_healthy
    ports:
      - ${KONG_HTTP_PORT}:8000/tcp
      - ${KONG_HTTPS_PORT}:8443/tcp
    volumes:
      # [self-platform] kong-plt.yml: no dashboard basic-auth, + platform-auth route
      - ./volumes/api/kong-plt.yml:/home/kong/temp.yml:ro,z
      - ../volumes/api/kong-entrypoint.sh:/home/kong/kong-entrypoint.sh:ro,z
    environment:
      KONG_DATABASE: 'off'
      KONG_DECLARATIVE_CONFIG: /usr/local/kong/kong.yml
      KONG_ROUTER_FLAVOR: expressions
      KONG_DNS_ORDER: LAST,A,CNAME
      KONG_DNS_NOT_FOUND_TTL: 1
      KONG_PLUGINS: request-transformer,cors,key-auth,acl,basic-auth,request-termination,ip-restriction,post-function
      KONG_NGINX_PROXY_PROXY_BUFFER_SIZE: 160k
      KONG_NGINX_PROXY_PROXY_BUFFERS: 64 160k
      KONG_PROXY_ACCESS_LOG: /dev/stdout combined
      SUPABASE_ANON_KEY: ${ANON_KEY}
      SUPABASE_SERVICE_KEY: ${SERVICE_ROLE_KEY}
      SUPABASE_PUBLISHABLE_KEY: ${SUPABASE_PUBLISHABLE_KEY:-}
      SUPABASE_SECRET_KEY: ${SUPABASE_SECRET_KEY:-}
      ANON_KEY_ASYMMETRIC: ${ANON_KEY_ASYMMETRIC:-}
      SERVICE_ROLE_KEY_ASYMMETRIC: ${SERVICE_ROLE_KEY_ASYMMETRIC:-}
    entrypoint: ['/bin/sh', '/home/kong/kong-entrypoint.sh']

  # >>> splice byte-copied services here: auth, rest, realtime, storage,
  # >>> imgproxy, meta, functions (see copy policy table above)

  db:
    container_name: supabase-db
    image: deluxebear/postgres:17
    restart: unless-stopped
    volumes:
      - ../volumes/db/realtime.sql:/docker-entrypoint-initdb.d/migrations/99-realtime.sql:Z
      - ../volumes/db/webhooks.sql:/docker-entrypoint-initdb.d/init-scripts/98-webhooks.sql:Z
      - ../volumes/db/roles.sql:/docker-entrypoint-initdb.d/init-scripts/99-roles.sql:Z
      - ../volumes/db/jwt.sql:/docker-entrypoint-initdb.d/init-scripts/99-jwt.sql:Z
      - ./volumes/db/data:/var/lib/postgresql/data:Z
      - ../volumes/db/_supabase.sql:/docker-entrypoint-initdb.d/migrations/97-_supabase.sql:Z
      - ../volumes/db/logs.sql:/docker-entrypoint-initdb.d/migrations/99-logs.sql:Z
      - ../volumes/db/pooler.sql:/docker-entrypoint-initdb.d/migrations/99-pooler.sql:Z
      # [self-platform] control-plane database in the shared cluster
      - ./volumes/db/_platform.sql:/docker-entrypoint-initdb.d/migrations/97-_platform.sql:Z
      - ./volumes/db/platform-migrations.sql:/docker-entrypoint-initdb.d/migrations/98-platform-migrations.sql:Z
      - ../volumes/platform/migrations:/platform-migrations:ro,z
      - db-config:/etc/postgresql-custom
    healthcheck:
      test: ['CMD', 'pg_isready', '-U', 'postgres', '-h', 'localhost']
      interval: 5s
      timeout: 5s
      retries: 10
    environment:
      POSTGRES_HOST: /var/run/postgresql
      PGPORT: ${POSTGRES_PORT}
      POSTGRES_PORT: ${POSTGRES_PORT}
      PGPASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      PGDATABASE: ${POSTGRES_DB}
      POSTGRES_DB: ${POSTGRES_DB}
      JWT_SECRET: ${JWT_SECRET}
      JWT_EXP: ${JWT_EXPIRY}
      # [self-platform] consumed by 97-_platform.sql at initdb
      PLATFORM_POSTGRES_PASSWORD: ${PLATFORM_POSTGRES_PASSWORD}
    command:
      [
        'postgres',
        '-c',
        'config_file=/etc/postgresql/postgresql.conf',
        '-c',
        'log_min_messages=fatal',
      ]

  # >>> splice byte-copied supavisor here (pooler.exs path rewritten to ../volumes/…)

  # --- [self-platform] control plane -----------------------------------------

  platform-mail:
    container_name: supabase-platform-mail
    image: axllent/mailpit:v1.20
    restart: unless-stopped
    ports:
      - '127.0.0.1:${PLATFORM_MAILPIT_SMTP_HOST_PORT:-1025}:1025'
      - '127.0.0.1:${PLATFORM_MAILPIT_UI_HOST_PORT:-8025}:8025'
    environment:
      MP_SMTP_AUTH_ACCEPT_ANY: 'true'
      MP_SMTP_AUTH_ALLOW_INSECURE: 'true'

  platform-auth:
    container_name: supabase-platform-auth
    image: supabase/gotrue:v2.189.0
    restart: unless-stopped
    depends_on:
      db:
        condition: service_healthy
      platform-mail:
        condition: service_started
    healthcheck:
      test: ['CMD', 'wget', '--no-verbose', '--tries=1', '--spider', 'http://localhost:9999/health']
      interval: 5s
      timeout: 5s
      retries: 10
    # [self-platform] No host port: the browser reaches this GoTrue through
    # Kong at ${SUPABASE_PUBLIC_URL}/platform-auth/v1 (kong-plt.yml route).
    environment:
      GOTRUE_API_HOST: 0.0.0.0
      GOTRUE_API_PORT: 9999
      API_EXTERNAL_URL: ${SUPABASE_PUBLIC_URL}/platform-auth/v1

      GOTRUE_DB_DRIVER: postgres
      GOTRUE_DB_DATABASE_URL: postgres://platform_admin:${PLATFORM_POSTGRES_PASSWORD}@db:${POSTGRES_PORT}/_platform

      GOTRUE_SITE_URL: ${SUPABASE_PUBLIC_URL}
      GOTRUE_URI_ALLOW_LIST: ${SUPABASE_PUBLIC_URL}/**
      GOTRUE_DISABLE_SIGNUP: 'true'

      GOTRUE_JWT_ADMIN_ROLES: service_role
      GOTRUE_JWT_AUD: authenticated
      GOTRUE_JWT_DEFAULT_GROUP_NAME: authenticated
      GOTRUE_JWT_EXP: ${PLATFORM_JWT_EXPIRY:-3600}
      GOTRUE_JWT_SECRET: ${PLATFORM_JWT_SECRET}

      GOTRUE_EXTERNAL_EMAIL_ENABLED: 'true'
      GOTRUE_MAILER_AUTOCONFIRM: 'true'

      # Empty USER/PASS by default: GoTrue's gomail only skips SMTP AUTH when
      # Username == "", and Go's PlainAuth refuses credentials over the
      # non-TLS Mailpit listener (host != "localhost"). Real providers set
      # real PLATFORM_SMTP_USER/PASS in .env. (Carried over verbatim from
      # docker-compose.platform.yml — see its longer rationale comment.)
      GOTRUE_SMTP_HOST: ${PLATFORM_SMTP_HOST:-platform-mail}
      GOTRUE_SMTP_PORT: ${PLATFORM_SMTP_PORT:-1025}
      GOTRUE_SMTP_USER: ${PLATFORM_SMTP_USER:-}
      GOTRUE_SMTP_PASS: ${PLATFORM_SMTP_PASS:-}
      GOTRUE_SMTP_ADMIN_EMAIL: ${PLATFORM_SMTP_ADMIN_EMAIL:-admin@internal.test}
      GOTRUE_SMTP_SENDER_NAME: ${PLATFORM_SMTP_SENDER_NAME:-Supabase Platform}
      GOTRUE_MAILER_URLPATHS_INVITE: /verify
      GOTRUE_MAILER_URLPATHS_RECOVERY: /verify
      GOTRUE_MAILER_URLPATHS_EMAIL_CHANGE: /verify
      GOTRUE_MAILER_URLPATHS_CONFIRMATION: /verify

  # >>> splice byte-copied analytics, vector, cadvisor here, each with
  # >>> profiles: ["obs"] added and vector.yml path rewritten to ../volumes/…

volumes:
  db-config:
  deno-cache:
```

- [ ] **Step 2: Write `.env.example`**

Copy `docker/.env.example`, then: delete the `DASHBOARD_USERNAME` and `DASHBOARD_PASSWORD` lines, and append:

```bash
############
# [self-platform] Control plane
# PLATFORM_ADMIN_PASSWORD must not contain double quotes (bootstrap.sh embeds
# it in JSON). Rotate every value below before first boot.
############

PLATFORM_POSTGRES_PASSWORD=your-platform-db-password
PLATFORM_JWT_SECRET=your-platform-jwt-secret-with-at-least-32-characters
PLATFORM_ENCRYPTION_KEY=your-platform-registry-encryption-key
PLATFORM_JWT_EXPIRY=3600

# First dashboard admin, created by scripts/bootstrap.sh
PLATFORM_ADMIN_EMAIL=admin@internal.test
PLATFORM_ADMIN_PASSWORD=change-me-strong-password

# Invite/recovery email. Defaults to the bundled Mailpit (dev). For real SMTP
# set host/port/user/pass — see the SMTP AUTH note in docker-compose.yml.
PLATFORM_SMTP_HOST=platform-mail
PLATFORM_SMTP_PORT=1025
PLATFORM_SMTP_USER=
PLATFORM_SMTP_PASS=
PLATFORM_SMTP_ADMIN_EMAIL=admin@internal.test
PLATFORM_SMTP_SENDER_NAME=Supabase Platform
PLATFORM_MAILPIT_SMTP_HOST_PORT=1025
PLATFORM_MAILPIT_UI_HOST_PORT=8025

# Set to "true" when running the obs profile (docker compose --profile obs up -d)
ENABLED_FEATURES_LOGS_ALL=false
```

- [ ] **Step 3: Validate compose config and boot the control-plane subset**

```bash
cd docker/self-platform
cp .env.example .env
docker compose config > /dev/null && echo CONFIG-OK
docker compose config --profile obs > /dev/null && echo OBS-CONFIG-OK
mkdir -p volumes/storage volumes/functions volumes/snippets volumes/db/data
cp -r ../volumes/functions/* volumes/functions/ 2>/dev/null || true
docker compose up -d db platform-mail platform-auth
sleep 30
docker compose ps --format '{{.Name}}\t{{.Status}}'
docker exec supabase-db psql -U supabase_admin -d _platform -tAc "select count(*) from platform.organizations;"
docker compose down
```

Expected: both `CONFIG-OK`; db + platform-auth report `healthy` (GoTrue healthy proves its migrations ran into `_platform`'s auth schema and `search_path` is right); org count `1`. Note: `functions` needs a `main` function to boot — copying `../volumes/functions/*` provides it for later full-stack runs.

- [ ] **Step 4: Commit**

```bash
git add docker/self-platform/docker-compose.yml docker/self-platform/.env.example
git commit -m "feat(self-platform): all-in-one compose (shared-cluster control plane, no dashboard basic-auth)"
```

---

### Task 4: `scripts/bootstrap.sh`

**Files:**

- Create: `docker/self-platform/scripts/bootstrap.sh` (mode 755)

**Interfaces:**

- Consumes: `.env` (read via `envval`, never `source`d — upstream values contain unquoted spaces), running stack from Task 3, `../volumes/platform/migrations/*.sql`, `platform.member_roles(profile_id, role_id)` with `role_id 1 = Owner` (see `docker/volumes/platform/README.md` "Bootstrapping the first admin"), upsert statement mirroring `buildUpsertSql()` in `docker/scripts/platform/register-project.ts`.
- Produces: idempotent 3-phase bootstrap. E2E (Task 7) runs it twice.

- [ ] **Step 1: Prove openssl ↔ crypto-js AES compatibility (BEFORE writing the script)**

```bash
CT=$(printf 'hello-secret' | openssl enc -aes-256-cbc -md md5 -base64 -A -pass pass:testkey)
cd apps/studio
node -e "const c=require('crypto-js');console.log(c.AES.decrypt('$CT','testkey').toString(c.enc.Utf8))"
```

Expected: `hello-secret` (crypto-js `AES.encrypt(str, passphrase)` uses the OpenSSL EVP `Salted__`/MD5-KDF format; `lib/api/self-platform/secrets.ts` decrypts the same way). **If this prints empty/garbage, STOP**: replace the `enc()` helper below with a node one-liner that requires crypto-js from `apps/studio/node_modules`, document the node runtime requirement in Task 6, and note the deviation in the task report.

- [ ] **Step 2: Write `bootstrap.sh`**

```bash
#!/usr/bin/env bash
# [self-platform] Idempotent bootstrap for the all-in-one stack. Safe to re-run.
#   Phase 1: ensure the _platform database exists (pre-existing PGDATA volumes;
#            fresh volumes already got it from docker-entrypoint-initdb.d).
#   Phase 2: ensure the first admin exists, has a profile, and holds Owner.
#   Phase 3: register/refresh the default project in platform.projects.
# Requires: docker, curl, openssl. No node/psql needed on the host.
set -Eeuo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "ERROR: missing .env (cp .env.example .env first)" >&2; exit 1; }
# .env values may contain unquoted spaces (upstream style) — never `source` it.
envval() { grep -E "^$1=" .env | head -1 | cut -d= -f2-; }

POSTGRES_PASSWORD="$(envval POSTGRES_PASSWORD)"
POSTGRES_PORT="$(envval POSTGRES_PORT)"
POSTGRES_DB="$(envval POSTGRES_DB)"
JWT_SECRET="$(envval JWT_SECRET)"
ANON_KEY="$(envval ANON_KEY)"
SERVICE_ROLE_KEY="$(envval SERVICE_ROLE_KEY)"
SUPABASE_PUBLIC_URL="$(envval SUPABASE_PUBLIC_URL)"; SUPABASE_PUBLIC_URL="${SUPABASE_PUBLIC_URL%/}"
SUPABASE_PUBLISHABLE_KEY="$(envval SUPABASE_PUBLISHABLE_KEY)"
SUPABASE_SECRET_KEY="$(envval SUPABASE_SECRET_KEY)"
PLATFORM_POSTGRES_PASSWORD="$(envval PLATFORM_POSTGRES_PASSWORD)"
PLATFORM_JWT_SECRET="$(envval PLATFORM_JWT_SECRET)"
PLATFORM_ENCRYPTION_KEY="$(envval PLATFORM_ENCRYPTION_KEY)"
PLATFORM_ADMIN_EMAIL="$(envval PLATFORM_ADMIN_EMAIL)"
PLATFORM_ADMIN_PASSWORD="$(envval PLATFORM_ADMIN_PASSWORD)"
LOGFLARE_PRIVATE_ACCESS_TOKEN="$(envval LOGFLARE_PRIVATE_ACCESS_TOKEN)"
ENABLED_FEATURES_LOGS_ALL="$(envval ENABLED_FEATURES_LOGS_ALL)"
PROJECT_NAME="$(envval STUDIO_DEFAULT_PROJECT)"; PROJECT_NAME="${PROJECT_NAME:-Default Project}"

for v in POSTGRES_PASSWORD SUPABASE_PUBLIC_URL PLATFORM_POSTGRES_PASSWORD \
         PLATFORM_JWT_SECRET PLATFORM_ENCRYPTION_KEY PLATFORM_ADMIN_EMAIL \
         PLATFORM_ADMIN_PASSWORD SERVICE_ROLE_KEY ANON_KEY JWT_SECRET; do
  [ -n "$(eval "printf '%s' \"\$$v\"")" ] || { echo "ERROR: $v is empty in .env" >&2; exit 1; }
done

DB_CONTAINER="${DB_CONTAINER:-supabase-db}"
PSQL() { docker exec -i "$DB_CONTAINER" psql -U supabase_admin -v ON_ERROR_STOP=1 -q "$@"; }
sqlq() { printf '%s' "$1" | sed "s/'/''/g"; }   # SQL single-quote escaping
enc()  { printf '%s' "$1" | openssl enc -aes-256-cbc -md md5 -base64 -A -pass pass:"$PLATFORM_ENCRYPTION_KEY"; }

echo "== Phase 1: _platform database =="
if ! PSQL -tAc "select 1 from pg_roles where rolname='platform_admin'" | grep -q 1; then
  PSQL -c "create role platform_admin login password '$(sqlq "$PLATFORM_POSTGRES_PASSWORD")'"
  echo "created role platform_admin"
fi
if ! PSQL -tAc "select 1 from pg_database where datname='_platform'" | grep -q 1; then
  PSQL -c "create database _platform owner platform_admin"
  echo "created database _platform"
fi
PSQL -c "alter role platform_admin in database _platform set search_path = public, auth"
if ! PSQL -d _platform -tAc "select 1 from information_schema.tables where table_schema='platform' and table_name='projects'" | grep -q 1; then
  for f in ../volumes/platform/migrations/*.sql; do
    echo "applying $(basename "$f")"
    { echo "set role platform_admin;"; cat "$f"; } | PSQL -d _platform
  done
else
  echo "platform schema present — skipping migrations (apply newer files manually; see README)"
fi

echo "== Phase 2: first admin =="
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
now=$(date +%s); exp=$((now + 60))
hdr=$(printf '{"alg":"HS256","typ":"JWT"}' | b64url)
pay=$(printf '{"role":"service_role","iat":%d,"exp":%d}' "$now" "$exp" | b64url)
sig=$(printf '%s.%s' "$hdr" "$pay" | openssl dgst -binary -sha256 -hmac "$PLATFORM_JWT_SECRET" | b64url)
SVC_JWT="$hdr.$pay.$sig"
GOTRUE="$SUPABASE_PUBLIC_URL/platform-auth/v1"

echo "waiting for studio through kong..."
for _ in $(seq 1 60); do
  curl -fsS -o /dev/null "$SUPABASE_PUBLIC_URL/api/platform/telemetry/feature-flags" && break
  sleep 2
done

# Create the admin (idempotent: 422 "already registered" tolerated).
curl -sS -o /tmp/plt-admin-create.json -X POST "$GOTRUE/admin/users" \
  -H "Authorization: Bearer $SVC_JWT" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$PLATFORM_ADMIN_EMAIL\",\"password\":\"$PLATFORM_ADMIN_PASSWORD\",\"email_confirm\":true}" \
  || { echo "ERROR: platform GoTrue unreachable at $GOTRUE" >&2; exit 1; }

TOKEN=$(curl -fsS -X POST "$GOTRUE/token?grant_type=password" -H 'Content-Type: application/json' \
  -d "{\"email\":\"$PLATFORM_ADMIN_EMAIL\",\"password\":\"$PLATFORM_ADMIN_PASSWORD\"}" \
  | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
[ -n "$TOKEN" ] || { echo "ERROR: admin login failed (wrong PLATFORM_ADMIN_PASSWORD for an existing user?)" >&2; exit 1; }

# First profile fetch auto-creates platform.profiles + default-org membership (M1).
curl -fsS -o /dev/null "$SUPABASE_PUBLIC_URL/api/platform/profile" -H "Authorization: Bearer $TOKEN"
PSQL -d _platform -c "insert into platform.member_roles (profile_id, role_id)
  select pr.id, 1 from platform.profiles pr
  where pr.primary_email = '$(sqlq "$PLATFORM_ADMIN_EMAIL")'
  on conflict do nothing;"
echo "admin $PLATFORM_ADMIN_EMAIL ready (Owner)"

echo "== Phase 3: register default project =="
LOGFLARE_URL_SQL="NULL"; LOGFLARE_TOKEN_SQL="NULL"; METRICS_URL_SQL="NULL"
if [ "$ENABLED_FEATURES_LOGS_ALL" = "true" ]; then
  LOGFLARE_URL_SQL="'http://analytics:4000'"
  [ -n "$LOGFLARE_PRIVATE_ACCESS_TOKEN" ] && LOGFLARE_TOKEN_SQL="'$(sqlq "$(enc "$LOGFLARE_PRIVATE_ACCESS_TOKEN")")'"
  METRICS_URL_SQL="'http://vector:9598'"
fi
PUB_SQL="NULL"; SEC_SQL="NULL"
[ -n "$SUPABASE_PUBLISHABLE_KEY" ] && PUB_SQL="'$(sqlq "$(enc "$SUPABASE_PUBLISHABLE_KEY")")'"
[ -n "$SUPABASE_SECRET_KEY" ] && SEC_SQL="'$(sqlq "$(enc "$SUPABASE_SECRET_KEY")")'"

PSQL -d _platform <<SQL
insert into platform.projects
  (ref, organization_id, name, status, cloud_provider, region,
   db_host, db_port, db_name, db_user, db_user_readonly, kong_url, rest_url,
   db_pass_enc, service_key_enc, anon_key_enc, jwt_secret_enc,
   publishable_key_enc, secret_key_enc, logflare_url, logflare_token_enc,
   metrics_url, metrics_token_enc, stack_kind, container_name, k8s_namespace, k8s_pod_selector)
values
  ('default', (select id from platform.organizations where slug='default'),
   '$(sqlq "$PROJECT_NAME")', 'ACTIVE_HEALTHY', 'AWS', 'local',
   'db', $POSTGRES_PORT, '$(sqlq "$POSTGRES_DB")', 'supabase_admin', 'supabase_read_only_user',
   '$(sqlq "$SUPABASE_PUBLIC_URL")', '$(sqlq "$SUPABASE_PUBLIC_URL")/rest/v1/',
   '$(sqlq "$(enc "$POSTGRES_PASSWORD")")', '$(sqlq "$(enc "$SERVICE_ROLE_KEY")")',
   '$(sqlq "$(enc "$ANON_KEY")")', '$(sqlq "$(enc "$JWT_SECRET")")',
   $PUB_SQL, $SEC_SQL, $LOGFLARE_URL_SQL, $LOGFLARE_TOKEN_SQL,
   $METRICS_URL_SQL, NULL, 'external', 'supabase-db', NULL, NULL)
on conflict (ref) do update set
  name=excluded.name, status=excluded.status,
  db_host=excluded.db_host, db_port=excluded.db_port, db_name=excluded.db_name,
  db_user=excluded.db_user, db_user_readonly=excluded.db_user_readonly,
  kong_url=excluded.kong_url, rest_url=excluded.rest_url,
  db_pass_enc=excluded.db_pass_enc, service_key_enc=excluded.service_key_enc,
  anon_key_enc=excluded.anon_key_enc, jwt_secret_enc=excluded.jwt_secret_enc,
  publishable_key_enc=excluded.publishable_key_enc, secret_key_enc=excluded.secret_key_enc,
  logflare_url=excluded.logflare_url, logflare_token_enc=excluded.logflare_token_enc,
  metrics_url=excluded.metrics_url,
  stack_kind=excluded.stack_kind, container_name=excluded.container_name,
  updated_at=now();
SQL
echo "default project registered"
echo "== bootstrap complete =="
```

- [ ] **Step 3: Static checks**

```bash
bash -n docker/self-platform/scripts/bootstrap.sh
shellcheck docker/self-platform/scripts/bootstrap.sh
chmod +x docker/self-platform/scripts/bootstrap.sh
```

Expected: no errors (SC2016-style info notes acceptable; fix all warnings).

- [ ] **Step 4: JWT mint spot-check (no stack needed)**

Extract the mint logic into an inline check — run the same three lines with `PLATFORM_JWT_SECRET=test-secret`, then verify with node against the repo's jsonwebtoken-compatible decode:

```bash
cd apps/studio && node -e "
const crypto=require('crypto');
const [h,p,s]=process.argv[1].split('.');
const expect=crypto.createHmac('sha256','test-secret').update(h+'.'+p).digest('base64url');
console.log(s===expect?'JWT-OK':'JWT-BAD');
" "<paste minted jwt>"
```

Expected: `JWT-OK`.

- [ ] **Step 5: Commit**

```bash
git add docker/self-platform/scripts/bootstrap.sh
git commit -m "feat(self-platform): idempotent bootstrap (existing-volume init, first admin, default project registration)"
```

---

### Task 5: `register-project.ts` container/user/db env overrides

**Files:**

- Modify: `docker/scripts/platform/register-project.ts` (the `psql()` helper, ~line 219)
- Test: `docker/scripts/platform/register-project.test.ts`

**Interfaces:**

- Consumes: existing `psql()` shape: `docker exec -i $PLATFORM_DB_CONTAINER psql -U postgres -d platform`.
- Produces: `PLATFORM_DB_USER` (default `postgres`) and `PLATFORM_DB_NAME` (default `platform`) env overrides so the CLI's `list`/`register`/`deregister` work against the merged stack (`PLATFORM_DB_CONTAINER=supabase-db PLATFORM_DB_USER=supabase_admin PLATFORM_DB_NAME=_platform`). Mini-stack behavior byte-identical by default.

- [ ] **Step 1: Write the failing test**

Append to `register-project.test.ts` (follow the file's existing mock/style conventions — it already tests `parseArgs`/`buildRowParams`; add a `psql argv` block using `vi.mock('node:child_process')` and `main(['list'])`):

```ts
describe('psql env overrides', () => {
  it('defaults to the mini-stack container/user/db', () => {
    delete process.env.PLATFORM_DB_CONTAINER
    delete process.env.PLATFORM_DB_USER
    delete process.env.PLATFORM_DB_NAME
    main(['list'])
    const argv = vi.mocked(execFileSync).mock.calls.at(-1)![1] as string[]
    expect(argv).toEqual([
      'exec',
      '-i',
      'supabase-platform-db',
      'psql',
      '-U',
      'postgres',
      '-d',
      'platform',
      '-v',
      'ON_ERROR_STOP=1',
    ])
  })
  it('honors PLATFORM_DB_CONTAINER/USER/NAME for the merged stack', () => {
    process.env.PLATFORM_DB_CONTAINER = 'supabase-db'
    process.env.PLATFORM_DB_USER = 'supabase_admin'
    process.env.PLATFORM_DB_NAME = '_platform'
    main(['list'])
    const argv = vi.mocked(execFileSync).mock.calls.at(-1)![1] as string[]
    expect(argv).toEqual([
      'exec',
      '-i',
      'supabase-db',
      'psql',
      '-U',
      'supabase_admin',
      '-d',
      '_platform',
      '-v',
      'ON_ERROR_STOP=1',
    ])
  })
})
```

- [ ] **Step 2: Run and verify it fails**

Run: `pnpm vitest run docker/scripts/platform/register-project.test.ts` (from repo root; match the invocation the existing test uses)
Expected: FAIL — second case gets `-U postgres -d platform`.

- [ ] **Step 3: Implement**

In `psql()` replace:

```ts
const container = process.env.PLATFORM_DB_CONTAINER || 'supabase-platform-db'
```

with:

```ts
const container = process.env.PLATFORM_DB_CONTAINER || 'supabase-platform-db'
// [self-platform] Merged-stack override: the all-in-one compose keeps the
// control plane in supabase-db/_platform (see docker/self-platform/).
const dbUser = process.env.PLATFORM_DB_USER || 'postgres'
const dbName = process.env.PLATFORM_DB_NAME || 'platform'
```

and the exec argv `['exec', '-i', container, 'psql', '-U', 'postgres', '-d', 'platform', '-v', 'ON_ERROR_STOP=1']` with `['exec', '-i', container, 'psql', '-U', dbUser, '-d', dbName, '-v', 'ON_ERROR_STOP=1']`.

- [ ] **Step 4: Run tests**

Run: `pnpm vitest run docker/scripts/platform/register-project.test.ts`
Expected: PASS (all pre-existing cases too).

- [ ] **Step 5: Commit**

```bash
git add docker/scripts/platform/register-project.ts docker/scripts/platform/register-project.test.ts
git commit -m "feat(self-platform): register CLI PLATFORM_DB_USER/PLATFORM_DB_NAME overrides for the merged stack"
```

---

### Task 6: README

**Files:**

- Create: `docker/self-platform/README.md`

**Interfaces:**

- Consumes: everything above.
- Produces: operator-facing doc. Must cover, each as its own section (write full prose, U.S. English):

- [ ] **Step 1: Write README.md** with exactly these sections:

1. **What this is** — one-compose self-platform stack; multi-account GoTrue dashboard login (invite-only + RBAC + optional MFA) replaces Kong basic-auth; control plane lives in `_platform` inside `supabase-db`; link to the spec and to `docker/volumes/platform/README.md` for the control-plane internals.
2. **Quickstart** — `cp .env.example .env`; rotate ALL secrets (inherited upstream demo values AND the `PLATFORM_*` block; suggest `openssl rand -base64 32`); `docker compose up -d`; `./scripts/bootstrap.sh`; open `${SUPABASE_PUBLIC_URL}`, log in as `PLATFORM_ADMIN_EMAIL`. Note bootstrap is idempotent and required exactly once (also after upgrades that add migrations).
3. **Inviting more operators** — Organization → Members UI; Mailpit UI at `http://localhost:8025` in dev; real SMTP via `PLATFORM_SMTP_*` (quote the AUTH/TLS caveat).
4. **Observability profile** — `ENABLED_FEATURES_LOGS_ALL=true` in `.env`, `docker compose --profile obs up -d`, re-run `./scripts/bootstrap.sh` (phase 3 re-registers logflare/metrics URLs).
5. **Migrating from the mini-stack** (`docker-compose.platform.yml` + dev server): `docker exec supabase-platform-db pg_dump -U postgres -d platform --no-owner` → restore into `_platform` via `docker exec -i supabase-db psql -U supabase_admin -d _platform`; both `platform.*` and `auth.*` schemas must arrive; then decommission `platform-db`/`platform-auth`/`platform-mail` mini-stack containers. Note: re-encrypt is NOT needed if `PLATFORM_ENCRYPTION_KEY` is carried over unchanged.
6. **Applying future platform migrations** — new files in `docker/volumes/platform/migrations/` are NOT auto-applied to existing volumes: `docker exec -i supabase-db psql -U supabase_admin -d _platform -v ON_ERROR_STOP=1 < ../volumes/platform/migrations/NN-new.sql`.
7. **Mutual exclusivity & ports** — identical container names/host ports as `docker/`; stop one stack before starting the other.
8. **TLS** — terminate at Kong (`KONG_SSL_CERT`) or an outer proxy; single origin covers studio + platform GoTrue + data plane; `SUPABASE_PUBLIC_URL` must be the https origin then.
9. **Registry CLI against this stack** — `PLATFORM_DB_CONTAINER=supabase-db PLATFORM_DB_USER=supabase_admin PLATFORM_DB_NAME=_platform pnpm tsx docker/scripts/platform/register-project.ts list` (register/deregister additional external stacks the same way).
10. **Blast radius note** — control plane shares the cluster: if `supabase-db` is down, dashboard login is down too; pgBackRest whole-cluster backups now include `_platform`.

- [ ] **Step 2: Commit**

```bash
git add docker/self-platform/README.md
git commit -m "docs(self-platform): all-in-one compose operator README"
```

---

### Task 7: E2E acceptance (controller-run, live stack)

**Files:** none (evidence in task report). Run from `docker/self-platform/` with a REAL `.env` (rotated secrets, `SUPABASE_PUBLIC_URL=http://192.168.1.100:8000` (must be container-reachable — never localhost; see README §2), `KONG_HTTP_PORT=8000` — adjust if occupied).

- [ ] **G1 — fresh boot**: wipe `volumes/db/data`, `docker compose up -d`, wait; `docker compose ps` shows every service healthy/running; `docker exec supabase-db psql -U supabase_admin -d _platform -c "\dt platform.*"` lists the tables from all 11 migrations (spot-check `projects`, `member_roles`, `metrics_samples`, `auth_config`).
- [ ] **G2 — bootstrap + login, twice**: `./scripts/bootstrap.sh` → success; run it AGAIN → success with "skipping"/no-op messages and no duplicate rows (`select count(*) from platform.member_roles` unchanged). Browser (or curl) to `http://localhost:8000/` → studio sign-in page, **no `WWW-Authenticate` header**; log in as the admin → default org visible.
- [ ] **G3 — manage the default project**: project card visible; SQL editor `select 1` succeeds (proves openssl-encrypted registry DSN decrypts in `secrets.ts`); Auth users page loads; Storage buckets page loads; `database/backups/scheduled` shows the observe-only notice.
- [ ] **G4 — multi-account**: invite `dev@internal.test` (Developer/Read-only role) from Members UI → open Mailpit `http://localhost:8025` → follow invite → set password → second browser session sees the project; verify a Read-only-scoped action is denied (e.g. SQL `create table` blocked with 403 toast) while `select` works.
- [ ] **G5 — obs profile**: set `ENABLED_FEATURES_LOGS_ALL=true`, `docker compose --profile obs up -d`, re-run `./scripts/bootstrap.sh`; Log Explorer returns Postgres logs; infra metrics charts render (container mode, `supabase-db`).
- [ ] **G6 — auth boundary**: `curl -sI http://localhost:8000/ | grep -i www-authenticate` → empty; `curl -s -o /dev/null -w '%{http_code}' http://localhost:8000/rest/v1/` → `401`; same for `/api/platform/projects` without a session → `401`.
- [ ] **Full suite regression**: `pnpm vitest run` under `apps/studio` scope used by CI (match the baseline count from the F4 log: 5145+, exit 0) — only Task 5 touched code, this guards it.
- [ ] **Commit any fixes discovered; record evidence in the task report.**

---

## Self-Review Notes

- Spec coverage: D1→T1/T3, D2→T4, D3→T2, D4/D5→T3, D6→T3+T4 phase 3+G5, D7→T3/T6; gates G1–G6→T7; CLI compat→T5; docs→T6. No uncovered spec section.
- Type/name consistency: `platform_admin`, `_platform`, `/platform-auth/v1`, `PLATFORM_DB_USER`/`PLATFORM_DB_NAME`, healthcheck path identical across T1/T2/T3/T4/T6.
- Known open verification (by design, has in-plan fallback): openssl↔crypto-js round-trip is T4 Step 1 and blocks the script if it fails.
