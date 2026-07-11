# Self-platform: all-in-one compose

This directory runs the full default Supabase stack **and** the self-hosted management
control plane in a single `docker compose` project. It is the merged-stack successor to
running the plain `docker/` stack side by side with the `docker-compose.platform.yml`
mini-stack: everything lives in one `docker compose up -d`, one `.env`, one Postgres
cluster.

For the design rationale and the full list of decisions behind this layout, see
[`docs/self-hosted-parity/2026-07-10-self-platform-compose-design.md`](../../docs/self-hosted-parity/2026-07-10-self-platform-compose-design.md).
For everything about the control plane's data model, RBAC, invitations, and the
`register-project` CLI (which this stack also uses), see
[`docker/volumes/platform/README.md`](../volumes/platform/README.md) — that document
covers the mini-stack's internals in depth and almost everything in it (schema, roles,
registry columns, encryption) applies here unchanged; this README only covers what's
different about running it as one merged stack.

## 1. What this is

`docker/self-platform/docker-compose.yml` (compose project `supabase-plt`) stands up the
same 11 services as the plain `docker/` stack — `db`, `kong`, `auth`, `rest`, `realtime`,
`storage`, `imgproxy`, `meta`, `functions`, `supavisor`, `studio` — plus the management
control plane: `platform-auth` (a dedicated GoTrue instance) and `platform-mail`
(Mailpit, for invite/recovery email in development). An optional `obs` profile adds
`analytics` (Logflare), `vector`, and `cadvisor` for logs and infra metrics.

The control plane's metadata — organizations, profiles, roles, project registry — lives
in a `_platform` database inside the same `supabase-db` Postgres cluster that holds the
project's own `postgres` database, mirroring the existing `_supabase` (`_analytics`/
`_supavisor`) pattern. There is no separate `platform-db` container in this stack.

Dashboard access control is **multi-account login**, not Kong basic-auth: the `kong`
service's dashboard route (`/`) has no `basic-auth` plugin (see
`volumes/api/kong-plt.yml`), and access is instead gated by the Studio image's own login
page — real sign-up/sign-in against `platform-auth` (invite-only registration, RBAC,
optional per-organization MFA enforcement) plus a default-deny `/api/platform/*` surface.
This is the same login gate the `docker-compose.platform.yml` mini-stack introduced;
this compose just runs it against the shared cluster instead of a standalone
`platform-db`/`platform-auth` pair.

The `studio` service runs `deluxebear/supabase-plt-studio:latest` (the platform-flavored
Studio image, `NEXT_PUBLIC_SELF_PLATFORM: 'true'`), not the plain `deluxebear/supabase-studio`
image the `docker/` stack uses.

## 2. Quickstart

Run every command below from this directory (`docker/self-platform/`).

1. **Copy the env file:**

   ```bash
   cp .env.example .env
   ```

2. **Rotate every secret before the first boot.** `.env.example` ships the same inherited
   upstream demo values the plain `docker/` stack ships (`POSTGRES_PASSWORD`, `JWT_SECRET`,
   `ANON_KEY`/`SERVICE_ROLE_KEY`, `SECRET_KEY_BASE`, `VAULT_ENC_KEY`, `PG_META_CRYPTO_KEY`,
   the `LOGFLARE_*` tokens, the `S3_PROTOCOL_*` keys) — these are public, well-known values
   from the upstream template and must be replaced. In addition, rotate the entire
   **`PLATFORM_*` block** at the bottom of `.env.example`: `PLATFORM_POSTGRES_PASSWORD`,
   `PLATFORM_JWT_SECRET` (at least 32 characters), `PLATFORM_ENCRYPTION_KEY`, and
   `PLATFORM_ADMIN_PASSWORD`. A generic generator for any of these is:

   ```bash
   openssl rand -base64 32
   ```

   **`PLATFORM_ADMIN_PASSWORD` must not contain a double-quote or backslash character** —
   `scripts/bootstrap.sh` embeds it verbatim inside a JSON payload (and again inside a
   curl config value) when it creates the first admin account, and an unescaped `"` or
   `\` will break those requests.

   > **`SUPABASE_PUBLIC_URL` must be an origin reachable FROM INSIDE the containers** —
   > a LAN IP (for example `http://192.168.1.100:8000`) or a real FQDN. **Never**
   > `http://localhost:8000` or `http://127.0.0.1:8000`, even though that's what
   > `.env.example` ships (kept for parity with upstream's convention). Two things break
   > with a loopback value: (1) Studio's server-side session verification dials
   > `NEXT_PUBLIC_GOTRUE_URL` (`${SUPABASE_PUBLIC_URL}/platform-auth/v1`) from inside its
   > own container, so a loopback address makes it hairpin back to itself instead of
   > reaching `platform-auth`. (2) Per-project data-plane calls dial the registry's
   > `kong_url` (also `${SUPABASE_PUBLIC_URL}`) the same way, so every REST/Auth/Storage
   > call the dashboard makes on your behalf fails too. Either way, the visible symptom
   > is every authenticated dashboard API request returning 401.
   > `scripts/bootstrap.sh` fails fast with this same warning if it detects a loopback
   > `SUPABASE_PUBLIC_URL`; the same check on `API_EXTERNAL_URL` is a non-fatal warning,
   > since that variable only feeds OAuth/SAML/email links and `GOTRUE_JWT_ISSUER`, not a
   > container-to-container dial.

3. **Populate the edge functions volume.** `./volumes/functions` is local, gitignored
   runtime state (see `.gitignore` in this directory) and starts out empty on a fresh
   checkout — the `functions` container's `--main-service` command point
   (`/home/deno/functions/main`) needs at least a `main` function to boot cleanly. Copy the
   repo's sample functions in before the first `docker compose up`:

   ```bash
   cp -r ../volumes/functions/. ./volumes/functions/
   ```

4. **Start the stack:**

   ```bash
   docker compose up -d
   ```

5. **Bootstrap the control plane:**

   ```bash
   ./scripts/bootstrap.sh
   ```

   This is required exactly once against any given `./volumes/db/data` volume — it
   initializes `_platform` (on pre-existing volumes; a brand-new volume already gets it
   from `docker-entrypoint-initdb.d`), creates the first dashboard admin from
   `PLATFORM_ADMIN_EMAIL`/`PLATFORM_ADMIN_PASSWORD` and grants it the Owner role, and
   registers the default project in `platform.projects`. The script is idempotent — safe
   to re-run — but a re-run only re-asserts the admin and refreshes the default
   project's registration (for example, to pick up the Logflare/metrics URLs after
   enabling the `obs` profile — see "Observability profile" below). It does **not**
   apply platform migrations added after the volume was initialized: once the platform
   schema exists, the script skips the migration step entirely, so new migration files
   always require the manual step in "Applying future platform migrations" below.

6. **Log in.** Open `${SUPABASE_PUBLIC_URL}` (`http://localhost:8000` by default) in a
   browser and sign in with `PLATFORM_ADMIN_EMAIL` / `PLATFORM_ADMIN_PASSWORD`.

## 3. Inviting more operators

Public self-registration is disabled (`GOTRUE_DISABLE_SIGNUP: 'true'` on `platform-auth`).
Add every operator after the first admin from inside the dashboard: the organization's
Members/Team settings page sends an invitation email through `platform-auth`; the invitee
follows the link to set a password and gets a role assigned from there (or via the same
UI, subject to the RBAC rules in `docker/volumes/platform/README.md`).

By default, invitation and recovery email is delivered through the bundled `platform-mail`
service (Mailpit) — a real SMTP sink meant for development, not delivery. Its web UI is
at **`http://localhost:8025`** (`PLATFORM_MAILPIT_UI_HOST_PORT`, bound to
`127.0.0.1` only); open it to read invite links instead of configuring a real mail
provider.

For real outbound email, set `PLATFORM_SMTP_HOST`, `PLATFORM_SMTP_PORT`,
`PLATFORM_SMTP_USER`, `PLATFORM_SMTP_PASS`, `PLATFORM_SMTP_ADMIN_EMAIL`, and
`PLATFORM_SMTP_SENDER_NAME` in `.env` and restart `platform-auth`. One caveat carried over
from the mini-stack: GoTrue's mailer only skips SMTP AUTH when the configured username is
empty, and Go's `PlainAuth` refuses to send credentials over a non-TLS connection to any
host other than `localhost` — which is exactly Mailpit's situation (empty
`PLATFORM_SMTP_USER`/`PLATFORM_SMTP_PASS` by default, host `platform-mail`). A real SMTP
provider normally supports TLS and requires real credentials, so setting
`PLATFORM_SMTP_USER`/`PLATFORM_SMTP_PASS` to that provider's actual credentials is what
makes AUTH work — leaving them blank against a real (non-`localhost`) host will fail.

## 4. Observability profile

Logs and infra metrics (`analytics`/Logflare, `vector`, `cadvisor`) are an opt-in
`docker compose` profile, not part of the base stack:

1. Set `ENABLED_FEATURES_LOGS_ALL=true` in `.env`.
2. Start the profile's services:

   ```bash
   docker compose --profile obs up -d
   ```

3. Re-run bootstrap so the default project's registry row picks up the Logflare and
   metrics URLs:

   ```bash
   ./scripts/bootstrap.sh
   ```

   Phase 3 of the script only fills in `logflare_url`/`logflare_token_enc`/`metrics_url`
   when `ENABLED_FEATURES_LOGS_ALL=true` at the time it runs, so this re-run is what
   actually lights up Log Explorer and the infra metrics charts — starting the `obs`
   profile alone is not enough. Without the profile (or before this re-run), Logs and
   metrics degrade honestly to empty, by design.

## 5. Migrating from the mini-stack

If you're moving an existing `docker-compose.platform.yml` mini-stack (`platform-db` +
`platform-auth` + `platform-mail`, see `docker/volumes/platform/README.md`) to this
all-in-one compose, bring the metadata over with a dump/restore rather than
re-registering everything by hand. The old and the new stack cannot run at the same time
(shared container names and host ports — see "Mutual exclusivity & ports" below), so the
sequence is: dump from the old stack first, decommission it, boot this stack, then
restore. All commands below run from this directory (`docker/self-platform/`);
`docker exec` targets a container by name regardless of the current directory.

1. **Dump the mini-stack's `platform` database** while the OLD stack is still running
   (its control-plane container is `supabase-platform-db`, superuser `postgres`):

   ```bash
   docker exec supabase-platform-db pg_dump -U postgres -d platform --no-owner > platform-dump.sql
   ```

2. **Decommission the old stack.** Stop and remove the mini-stack services, and bring
   the plain `docker/` stack down too — its container names and host ports collide with
   this stack's:

   ```bash
   docker compose -f ../docker-compose.yml -f ../docker-compose.platform.yml \
     stop platform-db platform-auth platform-mail
   docker compose -f ../docker-compose.yml -f ../docker-compose.platform.yml \
     rm -f platform-db platform-auth platform-mail
   docker compose -f ../docker-compose.yml down
   ```

3. **Boot this stack** (Quickstart steps 1–4 above), carrying `PLATFORM_ENCRYPTION_KEY`
   over **byte-identical** from the mini-stack's `docker/.env` into this stack's `.env`.
   Note that the first `docker compose up -d` runs initdb, which already creates
   `_platform` fully populated (schema, seed rows) — which is exactly why the next step
   drops it rather than restoring on top: restoring a full dump over the seeded schema
   aborts on "already exists" errors and unique violations.

4. **Drop, recreate, and restore `_platform`**, with the control-plane consumers
   stopped. Restore **as `platform_admin`** — ownership matters, because both Studio and
   platform GoTrue connect as `platform_admin`. The drop also removes the
   role-in-database `search_path` setting that `volumes/db/_platform.sql` established,
   so the recreate step re-applies it (GoTrue's unqualified lookups depend on it):

   ```bash
   docker compose stop studio platform-auth

   docker exec supabase-db psql -U supabase_admin -d postgres -v ON_ERROR_STOP=1 \
     -c "drop database _platform with (force)" \
     -c "create database _platform owner platform_admin" \
     -c "alter role platform_admin in database _platform set search_path = public, auth"
   docker exec -i supabase-db psql -h 127.0.0.1 -U platform_admin -d _platform \
     -v ON_ERROR_STOP=1 < platform-dump.sql

   docker compose start platform-auth studio
   ```

   (The `-h 127.0.0.1` on the restore is required: inside the `supabase-db` container,
   Unix-socket connections for roles other than `supabase_admin` use peer
   authentication, which fails for `platform_admin`; loopback TCP is trusted.)

   Verify **both** the hand-rolled `platform.*` schema (organizations, profiles, roles,
   projects) and GoTrue's own `auth.*` schema arrived — the mini-stack's `platform`
   database holds both in one place, and a partial dump/restore (e.g. `--schema=platform`
   only) will leave dashboard accounts unable to log in even though the registry looks
   fine.

**Re-encryption is not needed** if `PLATFORM_ENCRYPTION_KEY` in this stack's `.env` is
carried over byte-identical from the mini-stack's `docker/.env` (step 3) — the registry's
AES-encrypted secret columns (`db_pass_enc`, `service_key_enc`, etc.) decrypt exactly as
they did before. A mismatched or missing key makes every encrypted column undecryptable
(see `docker/volumes/platform/README.md`'s `PLATFORM_ENCRYPTION_KEY` section) — there is
no recovery for that short of re-registering every project.

**After the restore, do not re-run `./scripts/bootstrap.sh` unless you want the
`default` project row refreshed to this stack's `.env` values** — phase 3's upsert
overwrites the restored row's connection coordinates and encrypted secrets with what
`.env` currently says. That refresh is often what you want after moving stacks (new
`SUPABASE_PUBLIC_URL`, this stack's `db` host); skip it if the restored row should stand
as-is.

## 6. Applying future platform migrations

New files added to `docker/volumes/platform/migrations/` after your `./volumes/db/data`
volume was first initialized are **not** applied automatically — `docker-entrypoint-initdb.d`
(and this stack's `98-platform-migrations.sql` wrapper) only runs once, against a
genuinely empty `PGDATA`. New migrations must **also** be appended to
`volumes/db/platform-migrations.sql`'s hand-maintained `\i` list — it cannot glob the
migrations directory the way `scripts/bootstrap.sh` phase 1 does, so a forgotten line
means every future fresh volume silently skips that migration at initdb time. Apply a new
migration by hand against the running stack,
mirroring the replay pattern `scripts/bootstrap.sh` phase 1 uses — `set role
platform_admin` first, so the new objects are owned by `platform_admin`, the role Studio
and platform GoTrue connect as:

```bash
{ echo "set role platform_admin;"; cat ../volumes/platform/migrations/NN-new.sql; } | \
  docker exec -i supabase-db psql -U supabase_admin -d _platform -v ON_ERROR_STOP=1
```

Plain DDL migrations need nothing more. If a future migration ever needs cluster-level
rights beyond what `platform_admin` holds (the way `01-schema.sql` runs `alter role
postgres set search_path ...`), use `scripts/bootstrap.sh` phase 1's elevation bracket
— grant `createrole` and `postgres ... with admin option` before, revoke and restore the
`search_path` after, even on failure — as the reference.

`scripts/bootstrap.sh` prints `platform schema present — skipping migrations (apply newer
files manually; see README)` on every re-run once `platform.projects` already exists —
that message is this instruction.

**If a migration fails partway through:**

- **Fresh-volume (initdb) path** — a failure inside `98-platform-migrations.sql` during
  the very first `docker-entrypoint-initdb.d` run leaves `PGDATA` **half-initialized**:
  some platform migrations applied, others not, and — because that script's elevation
  cleanup (`revoke postgres from platform_admin`, restoring the `postgres` role's
  `search_path`) sits *after* the migration sequence — a failure can also skip that
  cleanup. Since `docker-entrypoint-initdb.d` never re-runs against a non-empty data
  directory, this state does not self-heal, and `bootstrap.sh`'s own "already
  initialized" check (does `platform.projects` exist?) can be satisfied by a partial run,
  masking the problem. The safe recovery is to wipe the volume and start clean:

  ```bash
  docker compose down
  rm -rf ./volumes/db/data
  docker compose up -d
  ```

- **Existing-volume (`bootstrap.sh` phase 1) path** — this path is written to always
  revoke `platform_admin`'s temporary elevation and restore the `postgres` role's
  `search_path`, **even when a migration file fails partway through the loop** (see the
  `mig_rc` handling in `scripts/bootstrap.sh`). A failure here does not leave the cluster
  in an elevated or corrupted state — just fix whatever the migration file's error was
  and re-run `./scripts/bootstrap.sh`.

## 7. Mutual exclusivity & ports

This stack reuses the plain `docker/` stack's container names byte-for-byte
(`supabase-db`, `supabase-kong`, `supabase-auth`, `supabase-studio`, `supabase-pooler`,
and so on) and the same default host ports (`KONG_HTTP_PORT=8000`,
`KONG_HTTPS_PORT=8443`, `POSTGRES_PORT=5432`, `POOLER_PROXY_PORT_TRANSACTION=6543`).
**The two stacks cannot run at the same time on one host.** Stop one (`docker compose
down`, run from its own directory) before starting the other.

## 8. TLS

There is no TLS termination in this stack by default — plan for one of:

- **Terminate at Kong.** Set `KONG_SSL_CERT`/`KONG_SSL_CERT_KEY` on the `kong` service
  (mount your certificate/key files and point the two env vars at them, the same pattern
  the plain `docker/docker-compose.yml` documents in its commented-out `kong.environment`
  block) and switch clients to `KONG_HTTPS_PORT` (`8443` by default, already published).
- **Terminate at an outer reverse proxy** in front of Kong (for example the parent
  directory's `docker-compose.caddy.yml`/`docker-compose.nginx.yml` overlays). If you
  reuse those overlays as-is, note that both `docker/volumes/proxy/caddy/Caddyfile` and
  `docker/volumes/proxy/nginx/supabase-nginx.conf.tpl` put HTTP basic-auth in front of the
  dashboard route — reintroducing exactly the basic-auth gate this stack's login page
  replaces. Strip that `basic_auth`/`auth_basic` block (or write a proxy config specific
  to this stack) if you want the dashboard reachable only through its own login page.
  Also note those overlays' volume mounts are relative (`./volumes/proxy/...`), which
  resolve against the compose project directory you invoke `docker compose` from — laying
  `-f ../docker-compose.caddy.yml` on top of this stack's compose file from
  `docker/self-platform/` resolves `./volumes/proxy/...` **here**, where it doesn't exist.
  Copy or adapt the overlay file (and the proxy config it mounts) into this directory
  rather than including the parent one directly.

Either way, a single origin serves the dashboard, platform GoTrue (`/platform-auth/v1`),
and the project's data plane (`/auth/v1`, `/rest/v1`, `/storage/v1`, `/realtime/v1`,
`/functions/v1`), so one certificate covers all of it. Once you terminate TLS,
`SUPABASE_PUBLIC_URL` (and `API_EXTERNAL_URL`) must be updated to the `https://` origin —
`platform-auth`'s `GOTRUE_SITE_URL`/`GOTRUE_URI_ALLOW_LIST` and the Studio image's runtime
`NEXT_PUBLIC_API_URL`/`NEXT_PUBLIC_GOTRUE_URL` placeholders are all derived from it.

## 9. Registry CLI against this stack

`docker/scripts/platform/register-project.ts` (documented in depth in
`docker/volumes/platform/README.md`) talks to the control-plane database via `docker exec
... psql`, defaulting to the mini-stack's container/user/database
(`supabase-platform-db` / `postgres` / `platform`). Point it at this stack's shared
cluster instead with three environment overrides:

```bash
PLATFORM_DB_CONTAINER=supabase-db PLATFORM_DB_USER=supabase_admin PLATFORM_DB_NAME=_platform \
  pnpm tsx docker/scripts/platform/register-project.ts list
```

(Run from the repo root, since the script path is repo-root-relative.) Register or
deregister additional external stacks the same way — add the three `PLATFORM_DB_*`
overrides in front of any `register`/`deregister`/`list` invocation documented in
`docker/volumes/platform/README.md`'s "`register-project` CLI" section.

## 10. Blast radius note

The control plane is no longer an isolated side-car — it shares the same Postgres
cluster and the same Kong/Studio front door as the project itself. Two consequences
worth being deliberate about:

- **If `supabase-db` is down, dashboard login is down too.** `platform-auth` and Studio's
  control-plane reads both depend on the same cluster the project's own data lives in;
  there is no independent metadata store to fail over to.
- **Cluster-wide backups now include `_platform`.** Whole-cluster backup tooling (for
  example pgBackRest) that backs up the `supabase-db` data directory captures `_platform`
  along with `postgres` and `_supabase` — the operator registry, roles, and invitations
  are restored together with the project data, with no separate backup step required.
