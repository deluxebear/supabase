# M1 Spike Findings: Platform-Mode Failure Inventory

**Date:** 2026-07-02
**Branch:** `feat/f9-f16-m1-login-gate`
**Scope:** Task 1 of the M1 login-gate plan — investigation only, no product code changed.

## Method

1. Backed up `apps/studio/.env.local` to `.env.local.selfhosted.bak`, then overrode it with
   `NEXT_PUBLIC_IS_PLATFORM=true`, `NEXT_PUBLIC_API_URL=http://localhost:8082/api`,
   `NEXT_PUBLIC_GOTRUE_URL=http://localhost:8100/auth/v1` (main-stack Kong), and
   `NEXT_PUBLIC_HCAPTCHA_SITE_KEY=10000000-ffff-ffff-ffff-000000000001` (hCaptcha's official
   public test sitekey), per the task brief.
2. Created a pre-confirmed spike user (`spike@internal.test`) directly via GoTrue's admin API
   (`POST /auth/v1/admin/users` with `SERVICE_ROLE_KEY`, `email_confirm: true`) because plain
   `/auth/v1/signup` 500s in this stack (`Error sending confirmation email` — no SMTP configured).
3. Started `pnpm dev:studio` in the background (log captured to a scratch file, mined for
   server-side stack traces) and drove the browser with the `browse` (gstack headless Chromium)
   skill: navigate, fill the sign-in form, read Network/Console panels.
4. Hit a real blocker getting past sign-in (see "Unexpected blocker" below) and worked around it
   by obtaining a session directly from GoTrue via curl and injecting it into
   `localStorage['supabase.dashboard.auth.token']` / `...-user` (the exact keys/shape
   `packages/common/gotrue.ts` + `@supabase/auth-js` `_saveSession` use), then reloading. This
   is the task's documented fallback ("obtain a real token from main-stack GoTrue... combine
   freely") adapted to get an authenticated _browser_ session rather than only curling endpoints.
5. Walked `/` → `/sign-in` → (session injected) → `/org` → `/organizations` →
   `/project/default` → `/project/default/editor`, capturing Network + Console at each step,
   cross-referenced against `apps/studio/data/**` via `rg` for the issuing hook, and against the
   dev-server log for server-side throws.
6. Restored `.env.local` from the backup (byte-identical, verified via checksum) and killed the
   dev server.

### Unexpected blocker (worth flagging, not a Task 1 deliverable to fix)

`packages/common/gotrue.ts` constructs the GoTrue `AuthClient` with **no `apikey` header**:

```ts
export const gotrueClient = new AuthClient({
  url: process.env.NEXT_PUBLIC_GOTRUE_URL,
  storageKey: STORAGE_KEY,
  ...
})
```

Real sign-in through the browser against the main stack's Kong (`localhost:8100`) therefore
always got `401 {"message":"No API key found in request"}` from Kong's key-auth plugin — this
was **not** the anon-key mismatch it first looked like (see below), but a header the client
never sends at all. Confirmed via Kong access logs (`docker compose logs kong`): the failing
browser requests carry a 96-byte body matching "No API key found in request", not the 81-byte
"Unauthorized" body that a wrong-but-present key would return. This means: **normal
username/password sign-in from the Studio UI cannot work against a Kong-fronted GoTrue as
currently wired**, independent of anything platform-auth (a later task) will add. Recorded for
awareness; not in scope to fix here.

Separately (and fixed locally as a spike-only `.env.local` addition, reverted at the end):
`apps/studio/.env` ships `NEXT_PUBLIC_SUPABASE_ANON_KEY` pinned to a stale placeholder project
ref (`xguihxuzqibwxjnimxev`) that doesn't match the main stack's real `ANON_KEY` in
`docker/.env`. This is a real latent bug (any code path that _does_ send this key will get
rejected by this stack's Kong) but was not the proximate cause of the sign-in 401 above.

Also hit a Turbopack persistent-cache gotcha: `.next/dev/cache/turbopack` only prunes entries
older than 3 days (`scripts/clean-turbopack-cache.mjs`), so changing `NEXT_PUBLIC_*` env vars and
restarting the dev server was **not** enough to pick up the new value — `rm -rf .next` was
required. Worth knowing for Tasks 2+ if env-driven behavior seems to not update after a restart.

## 中间件 404

`proxy.ts:14` (`matcher: '/api/:function*'`) returns 404 for every `/api/*` request when
`IS_PLATFORM=true` unless the path suffix-matches `lib/hosted-api-allowlist.ts`'s
`HOSTED_SUPPORTED_API_URLS`. That allowlist currently contains only:

```
/ai/sql/generate-v4, /ai/sql/policy, /ai/feedback/rate, /ai/code/complete, /ai/sql/cron-v2,
/ai/sql/title-v2, /ai/sql/filter-v1, /ai/onboarding/design, /ai/feedback/classify, /ai/docs,
/ai/sql/parse-client-code, /get-ip-address, /get-utc-time, /get-deployment-commit,
/check-cname, /edge-functions/test, /edge-functions/body, /generate-attachment-url,
/incident-status, /incident-banner, /status-override, /api/integrations/stripe-sync,
/content/graphql, /parse-query
```

**None of `/platform/*`, `/v1/*` (except the AI/status routes above), or `/pg-meta/*` are
allowlisted.** Every self-hosted-implemented endpoint under those prefixes 404s with:

```json
{ "success": false, "message": "Endpoint not supported on hosted" }
```

This is a blanket block — it fires before Next.js even routes to the handler, so no handler
code (including `assertSelfHosted`) runs for these paths in the current state.

## 服务端异常

`assertSelfHosted` (`lib/api/self-hosted/util.ts:17`) throws
`Error('This function can only be called in self-hosted environments')` whenever
`IS_PLATFORM===true`. **It never actually fired during this spike** — every route that calls it
is under `/api/platform/*` or `/api/v1/*`, which the middleware 404s first (see above), so the
handler body is unreached. Confirmed by grepping the dev-server log for
`self-hosted environments` / `assertSelfHosted`: zero matches across the whole session.

This means Tasks 2 and 3 are **sequentially entangled, not independently testable end-to-end**:
opening the allowlist (Task 2) without also relaxing `assertSelfHosted` (Task 3) will just swap
these routes' failure mode from 404 to 500, not fix them. Files that call `assertSelfHosted`
(all under `lib/api/self-hosted/`, each with the `pages/api/**` routes that reach them at
request time — this is the concrete list Task 3 should scope against):

| lib file                                 | reached via route(s)                                                                      |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| `lib/api/self-hosted/settings.ts`        | `pages/api/platform/projects/[ref]/settings.ts`                                           |
| `lib/api/self-hosted/query.ts`           | `pages/api/platform/pg-meta/[ref]/query/index.ts`                                         |
| `lib/api/self-hosted/api-keys.ts`        | `pages/api/v1/projects/[ref]/api-keys.ts`, `pages/api/v1/projects/[ref]/api-keys/[id].ts` |
| `lib/api/self-hosted/migrations.ts`      | `pages/api/v1/projects/[ref]/database/migrations.ts`                                      |
| `lib/api/self-hosted/generate-types.ts`  | `pages/api/v1/projects/[ref]/types/typescript.ts`                                         |
| `lib/api/self-hosted/signing-keys.ts`    | `pages/api/v1/projects/[ref]/config/auth/signing-keys/index.ts`, `.../legacy.ts`          |
| `lib/api/self-hosted/functions/index.ts` | `pages/api/v1/projects/[ref]/functions/index.ts`, `[slug]/index.ts`, `[slug]/body.ts`     |
| `lib/api/self-hosted/logs.ts`            | (grep-confirmed importer; route not exercised this spike — verify at Task 3 time)         |

Also note: `pages/api/platform/pg-meta/[ref]/query/index.ts` (Table Editor / SQL Editor's actual
query execution route) is a **single code path already shared by both self-hosted and platform
mode** — it calls `PG_META_URL` from `lib/constants` server-side; there is no separate
platform-only implementation to write. See conclusion (a).

## 前端 boot 请求缺口

Captured via headless-browser Network panel across `/` → `/sign-in` → `/org` → `/organizations`
→ `/project/default` → `/project/default/editor` (forced navigation). All are `/api/platform/*`
or `/api/v1/*` and all return `404` (middleware block) unless noted:

| Path                                                            | Status | Frontend hook (file)                                                                                                                          | First seen at               | Task 11 disposition                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/platform/notifications?offset=0&limit=20&status=new,seen` | 404    | `data/notifications/notifications-v2-query.ts`                                                                                                | pre-login boot (`/sign-in`) | **stubbed-now** — `pages/api/platform/notifications.ts`                                                                                                                                                                                                                                             |
| `/api/platform/telemetry/feature-flags`                         | 404    | `packages/common/feature-flags.tsx` (`getFeatureFlags`, called by `useFeatureFlags`/`FeatureFlagProvider`, exposed via `hooks/ui/useFlag.ts`) | pre-login boot              | **stubbed-now** — `pages/api/platform/telemetry/feature-flags.ts` (no auth: fires pre-login)                                                                                                                                                                                                        |
| `/api/platform/profile`                                         | 404    | `data/profile/profile-query.ts` (via `lib/profile.tsx` `ProfileProvider`)                                                                     | post-login (`/org`)         | **implemented-by-task-6**                                                                                                                                                                                                                                                                           |
| `/api/platform/profile/permissions`                             | 404    | `data/permissions/permissions-query.ts` (via `ProfileProvider`'s `usePermissionsQuery`)                                                       | post-login                  | **implemented-by-task-8**                                                                                                                                                                                                                                                                           |
| `/api/platform/stripe/invoices/overdue`                         | 404    | `data/invoices/invoices-overdue-query.ts`                                                                                                     | post-login                  | **stubbed-now** — `pages/api/platform/stripe/invoices/overdue.ts`                                                                                                                                                                                                                                   |
| `/api/platform/projects/default`                                | 404    | `data/projects/project-detail-query.ts` (via `hooks/misc/useSelectedProject.ts`)                                                              | `/project/default`          | **implemented-pre-existing** — `pages/api/platform/projects/[ref]/index.ts` is a generic self-hosted route (predates this branch) with no `IS_PLATFORM` gate; now reachable once Task 2's allowlist opened `/api/platform/*` for self-platform. See `## Task 11 关注点` for a real bug found in it. |
| `/api/platform/projects/default/databases`                      | 404    | `data/read-replicas/replicas-query.ts`                                                                                                        | `/project/default`          | **implemented-pre-existing** — `pages/api/platform/projects/[ref]/databases.ts`, same as above                                                                                                                                                                                                      |
| `/api/platform/projects/default/billing/addons`                 | 404    | `data/subscriptions/project-addons-query.ts`                                                                                                  | `/project/default`          | **implemented-pre-existing** — `pages/api/platform/projects/[ref]/billing/addons.ts`, same as above                                                                                                                                                                                                 |
| `/api/platform/telemetry/feature-flags?project_ref=default`     | 404    | `packages/common/feature-flags.tsx` (same hook, project-scoped call)                                                                          | `/project/default`          | **stubbed-now** — same file as the pre-login row above                                                                                                                                                                                                                                              |
| `/api/v1/projects/default/network-bans/retrieve` (POST)         | 404    | `data/banned-ips/banned-ips-query.ts`                                                                                                         | `/project/default`          | **stubbed-now** — `pages/api/v1/projects/[ref]/network-bans/retrieve.ts`                                                                                                                                                                                                                            |

### Task 11: newly-discovered gaps (deeper shell mount)

Once the profile → permissions → organizations → projects chain actually resolves (see
`## Task 11 关注点` below for what it took to get there live), the project shell mounts fully and
fires a second wave of requests the Task 1 spike never reached. Captured via live re-verification
(`/organizations` → `/org/default` → `/project/default` → Table Editor → SQL Editor), all
`stubbed-now` unless noted:

| Path                                                                | Status (before) | Frontend hook (file)                                  | First seen at                      | Disposition                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------- | --------------- | ----------------------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/platform/organizations/{slug}/entitlements`                   | 404             | `data/entitlements/entitlements-query.ts`             | `/org/default`                     | stubbed-now — `pages/api/platform/organizations/[slug]/entitlements.ts`                                                                                                                                                                                                                                                                                              |
| `/api/platform/organizations/{slug}/usage`                          | 404             | `data/usage/org-usage-query.ts`                       | `/org/default`                     | stubbed-now — `pages/api/platform/organizations/[slug]/usage.ts`                                                                                                                                                                                                                                                                                                     |
| `/api/platform/organizations/{slug}/oauth/apps?type=authorized`     | 404             | `data/oauth/authorized-apps-query.ts`                 | `/org/default`                     | stubbed-now — `pages/api/platform/organizations/[slug]/oauth/apps/index.ts`                                                                                                                                                                                                                                                                                          |
| `/api/platform/projects-resource-warnings?slug=...` / `?ref=...`    | 404             | `data/usage/resource-warnings-query.ts`               | `/org/default`, `/project/default` | stubbed-now — `pages/api/platform/projects-resource-warnings.ts` (called with both `slug` and `ref` query params by different call sites; same handler covers both)                                                                                                                                                                                                  |
| `/api/v1/projects/{ref}/branches`                                   | 404             | branches list hook (project overview branch selector) | `/project/default`                 | stubbed-now — `pages/api/v1/projects/[ref]/branches.ts` — **visibly broke the UI**: orange "Failed to load branches" banner in the project topbar                                                                                                                                                                                                                    |
| `/api/v1/projects/{ref}/health?services=...`                        | 404             | project health-status hook (project overview)         | `/project/default`                 | stubbed-now — `pages/api/v1/projects/[ref]/health.ts` — **visibly broke the UI**: project overview showed status "Unhealthy"                                                                                                                                                                                                                                         |
| `/api/platform/database/{ref}/backups`                              | 404             | project overview "Last backup" card                   | `/project/default`                 | stubbed-now — `pages/api/platform/database/[ref]/backups.ts`                                                                                                                                                                                                                                                                                                         |
| `/api/platform/projects/{ref}/load-balancers`                       | 404             | project overview / database settings                  | `/project/default`                 | stubbed-now — `pages/api/platform/projects/[ref]/load-balancers.ts`                                                                                                                                                                                                                                                                                                  |
| `/api/platform/projects/{ref}/databases-statuses`                   | 404             | project overview / database settings                  | `/project/default`                 | stubbed-now — `pages/api/platform/projects/[ref]/databases-statuses.ts`                                                                                                                                                                                                                                                                                              |
| `/api/v1/projects/{ref}/upgrade/status`                             | 404             | project overview upgrade-banner check                 | `/project/default`                 | stubbed-now — `pages/api/v1/projects/[ref]/upgrade/status.ts`                                                                                                                                                                                                                                                                                                        |
| `/api/platform/projects/{ref}/analytics/endpoints/usage.api-counts` | 500             | project overview request-count chart                  | `/project/default`                 | **intentionally-skipped** — pre-existing self-hosted route (`lib/api/self-hosted/logs.ts`) `assert`s `LOGFLARE_PRIVATE_ACCESS_TOKEN`; 500s identically in plain self-hosted mode today, not platform-specific. Non-blocking (chart area just stays empty).                                                                                                           |
| `/api/platform/auth/{ref}/config`                                   | 404             | Auth settings hook (sidebar-hover prefetch)           | stray, outside the explicit walk   | **intentionally-skipped (deferred)** — has a contract (`GoTrueConfigController_getGoTrueConfig`) but the response schema (`GoTrueConfigResponse`) is a large multi-field GoTrue settings object; never actually visited (Auth settings page), only prefetched on sidebar hover. Left for a follow-up task scoped to the Auth settings page rather than guessed here. |
| `/api/platform/projects/{ref}/config/storage`                       | 404             | Storage settings hook (sidebar-hover prefetch)        | stray, outside the explicit walk   | **intentionally-skipped (deferred)** — same reasoning, `StorageConfigResponse` is a large settings object; deferred to a Storage-settings-page task.                                                                                                                                                                                                                 |

All ten `stubbed-now` rows above are now typed contract-minimal stubs; all four
`intentionally-skipped` rows are documented in `## 有意不实现`.

Not observed (never reached — see conclusion a): any `/api/platform/pg-meta/*` or other
project-content routes (Table Editor grid data, SQL Editor snippets, etc.), because the project
shell itself never mounts — see below.

Not in scope of this table but observed and worth recording:

- `/api/incident-banner` → **500**, not 404 — it _is_ allowlisted (`/incident-banner` is in
  `HOSTED_SUPPORTED_API_URLS`), so it reaches its handler, which throws
  `Error('INCIDENT_IO_API_KEY is not set')` (`lib/api/incident-banner.ts:111`). This is
  independent of platform-mode work — it 500s identically in self-hosted mode today. Non-blocking
  (banner just doesn't render); flagged for question (c).
- `/api/get-deployment-commit` → 200 (allowlisted, works).

### Observed behavior vs. the brief's expected failure mode #3

The brief anticipated `GET /platform/profile` failing might make `ProfileProvider` sign the user
out and bounce back to `/sign-in`. **That is not what happens currently**, and the reason is
precise and important:

```ts
// lib/profile.tsx
if (error?.code === 401) {
  signOut().then(() => router.push('/sign-in'))
}
```

The middleware returns **404**, not 401, so this guard never fires. Instead:
`useOrganizationsQuery` (`data/organizations/organizations-query.ts`) is gated
`enabled: enabled && profile !== undefined`, and since `profile` stays `undefined` forever
(the query errors, it doesn't resolve to a value), **the organizations list request never even
fires**, and `/organizations` hangs in a permanent skeleton-loading state (screenshot evidence:
`/tmp/spike-shots/organizations-page.png`). Forcing `/project/default` client-side-redirects
back to `/organizations` (same skeleton) because `useSelectedProjectQuery` →
`project-detail-query.ts`'s 404 leaves `project` undefined and `ProjectLayout` bounces away.
**No sign-out loop, no redirect to `/sign-in` — a silent infinite-loading dead end.** This is a
materially different (and arguably worse — no error surfaced to the user at all) failure mode
than the brief assumed, and Task 2's allowlist scoping should account for the whole dependency
chain (profile → permissions → organizations → project-detail), not just `/platform/profile` in
isolation, or the same silent hang will persist even after `/platform/profile` starts 200'ing.

## 结论

**a) 数据页经 pg-meta 路由是否仅因 allowlist/assertSelfHosted 失败，还是另有平台形状分叉？**

Purely allowlist + assertSelfHosted — confirmed by code inspection, no separate platform-shape
divergence. `pages/api/platform/pg-meta/[ref]/query/index.ts` (the route Table Editor / SQL
Editor actually hit) already exists as a single shared implementation for both self-hosted and
platform mode, backed by `lib/api/self-hosted/query.ts` → `PG_META_URL` (server-side only, no
client-side branching). It calls `assertSelfHosted()` directly. **However**, this route is never
reachable today even to hit that throw, because the _chain_ of prerequisite calls
(`/platform/profile` → `/platform/profile/permissions` → `/platform/organizations` →
`/platform/projects/{ref}`) all 404 first and the project shell (`ProjectLayout`) never mounts —
see the boot-gap table above. **Task 2 must open the whole chain together** (profile,
permissions, notifications is optional/non-blocking, organizations, projects/{ref}, and
pg-meta/{ref}/query itself), and **Task 3 must land in the same rollout** (not a later,
independently-shippable step) or these routes just flip from 404 to 500 (`assertSelfHosted`
throw) with no net improvement in reachability.

**b) hCaptcha 测试 key 是否足够？**

Yes. `10000000-ffff-ffff-ffff-000000000001` renders, calls `checksiteconfig` and `getcaptcha`
against hCaptcha's real API and gets `200` back with a usable token with zero user interaction
(it's hCaptcha's documented always-pass test key), and the Sign In button becomes submittable.
No fallback/downgrade needed for hCaptcha itself. The blocker encountered was unrelated
(missing `apikey` header on the GoTrue client, see "Unexpected blocker" above) — not a captcha
issue.

**c) 外围 SDK 是否需要额外 env 兜底？**

No blocking gaps found; all three degrade non-fatally without their env vars:

- **ConfigCat**: `Skipping ConfigCat set up as env vars are not present` — `console.log` (info),
  no render impact.
- **PostHog**: `Flag key "..." does not exist in PostHog flag store` — `console.error` (noisy
  but non-fatal; `usePHFlag` returns `undefined`, callers treat that as "don't show").
- **Sentry**: `dsn: process.env.NEXT_PUBLIC_SENTRY_DSN` is `undefined` in this setup — the SDK
  silently no-ops (no console errors observed at all).
- **Usercentrics** (cookie-consent CMP): `Failed to initialize Usercentrics: ... statusCode: 403`
  on every navigation — non-blocking but noisy; not platform-mode-specific (same in self-hosted
  mode today), not something Task 2/3 need to fix, but worth a follow-up ticket to suppress in
  self-hosted deployments if it keeps showing up in QA noise.
- **incident-banner** (`INCIDENT_IO_API_KEY` unset) — 500 every load, non-blocking, pre-existing
  in self-hosted mode regardless of `IS_PLATFORM`. Not platform-mode scope.

None of these need an `.env.local` fallback to unblock M1; they're cosmetic/log-noise only.

## Task 11: contract-minimal boot stubs + live re-verification

Task 11 filled in every remaining `stubbed-now` path from the table above (10 files), then did a
LIVE re-verification (real dev server, real platform-auth session, headless-browser walk) rather
than code inspection. That surfaced three things worth recording that are **not** stub gaps and
were **not** fixed as part of this task (see rules in the task brief: don't patch existing
implemented endpoints, record concerns instead) — they were only patched **locally and
temporarily, then fully reverted before committing**, purely to get far enough into the app to
finish the walk and discover the stub-shaped gaps above.

**Concern 1 — `PLATFORM_PG_META_URL` is never set anywhere.** `lib/constants/index.ts` branches
`PG_META_URL` on `IS_PLATFORM`: self-hosted uses `STUDIO_PG_META_URL`/`PLATFORM_PG_META_URL`
depending on mode, but nothing in `docker/.env`/`.env.local`/the task brief's own env-var list
ever sets `PLATFORM_PG_META_URL`. Without it, `PG_META_URL` resolves to `undefined` and every
self-platform DB-backed route (`profile`, `organizations`, `projects`) 500s outright. **Not
reverted** — this is a pure env-var addition (`PLATFORM_PG_META_URL=http://localhost:8100/pg`,
same target as `STUDIO_PG_META_URL`) made only in the local `.env.local` for this verification
session, which was restored byte-identical afterwards. This needs to land as a real env default
(docker/.env or the platform mini-stack compose file) before any future task relies on a working
dev environment — flagging for whoever owns environment/deploy config next.

**Concern 2 (HIGH severity) — `lib/api/apiHelpers.ts`'s `constructHeaders()` strips the pg-meta
`apiKey` header whenever `IS_PLATFORM` is true.** Line ~31: `...(!IS_PLATFORM && { apiKey:
process.env.SUPABASE_SERVICE_KEY })`. This predates the whole M1 branch (last touched by an
import-order chore, `205cbe7d26`) and is not a Task 6-10 output, but Task 6-10's
`lib/api/self-platform/db.ts` (and every self-hosted-style pg-meta route) calls into it. Self-platform
mode sets `IS_PLATFORM=true` but still talks to the **same Kong-fronted pg-meta service as
self-hosted** (confirmed: `PLATFORM_PG_META_URL` points at the same `localhost:8100/pg` as
`STUDIO_PG_META_URL` — there is no separate platform-only pg-meta). Kong's key-auth plugin
requires this header; without it every platform-metadata DB query (profile, organizations,
projects, and the pg-meta bridge itself) 500s with `"No API key found in request"` wrapped as an
opaque `{"error":{}}` (Error serializes to `{}` through `apiWrapper`'s catch-all). **Reproduced
live**: `GET /api/platform/profile` 500'd with an empty profile table (should have been a clean
404 `"User's profile not found"`, which `lib/profile.tsx`'s `createProfile()` auto-recovery
depends on) until this was fixed. **Verified fix** (temporarily, then `git checkout`'d — not in
the commit): change the condition to always include the `apiKey` header (or gate it on whether
the target pg-meta is Kong-fronted, e.g. `!IS_PLATFORM || IS_SELF_PLATFORM`). After that one-line
change, `profile`/`organizations`/`projects` all returned correct data end-to-end. **This blocks
the entire self-platform DB story and needs a real (committed, reviewed) fix in a follow-up
task** — it is squarely infra-plumbing, not a missing-endpoint stub, so out of Task 11's charter
to fix directly.

**Concern 3 (HIGH severity) — the pre-existing (non-Task-6-10) `projects/[ref]/index.ts` route
always returns `connectionString: ''`, which is fatal in self-platform mode.**
`data/fetchers.ts`'s `pgMetaGuard()` calls `isValidConnString(connString)`, which is
`IS_PLATFORM ? Boolean(connString) : true` — i.e. self-hosted mode (`IS_PLATFORM=false`) always
bypasses this client-side gate regardless of the value, but self-platform mode (`IS_PLATFORM=true`)
enforces it. Since `pages/api/platform/projects/[ref]/index.ts` (generic self-hosted route,
predates this branch, no `IS_PLATFORM`/`IS_SELF_PLATFORM` branching) hardcodes
`connectionString: ''`, **every pg-meta-backed client request in self-platform mode is blocked
client-side before it's even sent** — Table Editor showed "Failed to load schemas — API Error:
happened while trying to acquire connection to the database" and "Failed to load tables" for the
identical reason, with zero `/api/platform/pg-meta/*` network requests ever firing (matches spike
conclusion (a)'s prediction, but from a different root cause than assumed — not
`assertSelfHosted`, but this client-side gate). Some pg-meta routes (`types.ts`, `publications.ts`,
`policies.ts`, etc.) additionally forward the client-supplied `connectionString` verbatim as the
`x-connection-encrypted` header to pg-meta, so it must be a _real_ encrypted connection string,
not just any truthy value. **Verified fix** (temporarily, then `git checkout`'d — not in the
commit): set `connectionString: encryptString(getConnectionString({ readOnly: false }))` (the
same helpers `lib/api/self-hosted/query.ts` already uses server-side) instead of `''`. After that
change plus Concern 2's fix, Table Editor and SQL Editor both rendered cleanly (no error banners,
"No tables or views", pg-meta `/types`, `/publications`, and `/query` POST all 200'd), and a
pre-existing on-disk snippet (`Untitled query 207`, `SELECT ... FROM pg_available_extensions`)
opened correctly. **Needs a real (committed, reviewed) fix in a follow-up task** — same reasoning
as Concern 2: this is a pre-existing shared file with a platform-shape gap, not a missing
endpoint.

Net effect: with Concerns 1-3 fixed (even if only locally/temporarily for this verification), the
full boot walk — sign-in → `/organizations` → `/org/default` → `/project/default` → Table Editor →
SQL Editor — is clean: no unexpected non-2xx `/api/*` requests, only the two documented
pre-existing non-platform-specific 500s (`/api/incident-banner`, analytics endpoints without
`LOGFLARE_PRIVATE_ACCESS_TOKEN`).

## 有意不实现

Paths deliberately left unstubbed, with justification:

- **`/api/platform/projects/{ref}/analytics/endpoints/*`** (project overview request-count chart)
  — 500s because `lib/api/self-hosted/logs.ts` `assert`s `LOGFLARE_PRIVATE_ACCESS_TOKEN`, which is
  unset. Identical behavior in plain self-hosted mode today — not platform-specific, pre-existing,
  non-blocking (chart area stays empty, no crash).
- **`/api/platform/auth/{ref}/config`** (Auth settings page config) — has a contract
  (`GoTrueConfigController_getGoTrueConfig` → `GoTrueConfigResponse`), but that response schema is
  a large multi-field GoTrue settings object (dozens of fields covering every auth provider/JWT/
  rate-limit setting). Only observed as a stray sidebar-hover prefetch during the SQL Editor walk,
  never from actually visiting the Auth settings page (out of this task's explicit walk scope:
  "Table Editor, SQL Editor at minimum"). Deferred to a task that actually implements the Auth
  settings page, where the real minimal-legal shape can be derived from what that page reads.
- **`/api/platform/projects/{ref}/config/storage`** (Storage settings page config) — same
  reasoning as above (`StorageConfigResponse` is a large settings object), same stray-prefetch
  origin, deferred to a Storage-settings-page task.
- **ConfigCat / PostHog / Sentry / Usercentrics / `/api/incident-banner`** — carried over from the
  Task 1 spike's conclusion (c); all degrade non-fatally without their env vars (console log/warn
  only, no render break), none are platform-mode-specific, none need an `.env.local` fallback.

## Files changed / restored

- `apps/studio/.env.local` — temporarily overridden for the spike, restored byte-identical to
  the pre-spike backup (verified via `md5`) before committing this doc.
- `docs/self-hosted-parity/2026-07-02-M1-spike-findings.md` — this file (committed).

### Task 11 additions

- `apps/studio/.env.local` — temporarily overridden again for the Task 11 live re-verification
  (self-platform env vars per the task's Step 3 + a discovered `PLATFORM_PG_META_URL` addition,
  see Concern 1), restored byte-identical to the pre-Task-11 version (verified via `md5`) before
  committing.
- `apps/studio/lib/api/apiHelpers.ts` and
  `apps/studio/pages/api/platform/projects/[ref]/index.ts` — temporarily patched locally to work
  around Concerns 2 and 3 solely to finish the live walk past those blockers; both fully reverted
  via `git checkout` before committing (confirmed clean via `git status`/`git diff`). Not part of
  this task's commit.
- 10 new contract-minimal stub route files under `apps/studio/pages/api/platform/` and
  `apps/studio/pages/api/v1/` (see the two tables above) — committed.

## M1 验收

**Date:** 2026-07-02. **Branch:** `feat/f9-f16-m1-login-gate`. Environment: platform mini-stack
(`platform-auth` :8110, `platform-db` :5434 host-port / 5432 in-container) + main self-hosted
stack (Kong :8100) both already running; Studio dev server (`pnpm dev:studio`, :8082) started
fresh against `apps/studio/.env.local`'s platform-mode profile (see top of this repo's
`docker/volumes/platform/README.md` for the full profile). Test user created via the real
sign-up UI: `m1-acceptance@internal.test`. Evidence screenshots referenced below live under
`.superpowers/sdd/task12-evidence-*.png` (gitignored scratch, not committed).

All 9 items were driven for real: real UI sign-up/sign-in against `platform-auth` (no session
injection), real TOTP generated by a throwaway inline Node script (HMAC-SHA1 over the base32
secret, `crypto` only, no new deps — script kept at `.superpowers/sdd/totp.mjs`), real SQL/table
writes verified independently via `docker exec ... psql` against the actual project database.

### 1. Unauthenticated `/project/default` → redirect to `/sign-in?returnTo=...`

**PASS.** Fresh (no cookies/localStorage) headless-browser navigation to
`http://localhost:8082/project/default` landed on
`http://localhost:8082/sign-in?returnTo=%2Fproject%2Fdefault`. Screenshot:
`task12-evidence-01-unauth-redirect.png` (sign-in form rendered, no console errors from this
route).

### 2. `/sign-up` registers a new user (autoconfirm, no email)

**PASS.** Real UI sign-up form submit for `m1-acceptance@internal.test`. Verified directly
against `platform-db`:

```
$ docker exec supabase-platform-db psql -U postgres -d platform -c \
  "select email, email_confirmed_at, created_at from auth.users where email = 'm1-acceptance@internal.test';"
            email            |      email_confirmed_at       |          created_at
-----------------------------+-------------------------------+-------------------------------
 m1-acceptance@internal.test | 2026-07-02 07:53:51.770303+00 | 2026-07-02 07:53:51.752763+00
(1 row)
```

`email_confirmed_at` set at the same instant as `created_at` — autoconfirm active, no email step.
(Minor cosmetic note, not a functional gap: the sign-up success screen still shows GoTrue's
generic "Check your email to confirm" copy even though autoconfirm means no confirmation is
actually required — pre-existing UI copy, not self-platform-specific, not in scope to change here.)

### 3. Login lands on `/organizations` / default org page, "Default Organization" visible

**PASS.** Real UI sign-in with the item-2 user. Landed on `http://localhost:8082/organizations`,
page text: `"...Your Organizations New organization Default Organization Enterprise Plan·1
project..."`. Screenshot: `task12-evidence-03-organizations.png`.

### 4. First-login auto-provisioning: `platform.profiles` + `platform.organization_members`

**PASS.**

```
$ docker exec supabase-platform-db psql -U postgres -d platform -c \
  "select username, primary_email from platform.profiles where primary_email = 'm1-acceptance@internal.test';"
   username    |        primary_email
---------------+-----------------------------
 m1-acceptance | m1-acceptance@internal.test
(1 row)

$ docker exec supabase-platform-db psql -U postgres -d platform -c \
  "select om.* from platform.organization_members om join platform.profiles p on p.id = om.profile_id where p.primary_email = 'm1-acceptance@internal.test';"
 organization_id | profile_id |          created_at
-----------------+------------+-------------------------------
               1 |          2 | 2026-07-02 07:54:12.238181+00
(1 row)
```

Dev-server log confirms the provisioning request itself: `POST /api/platform/profile 201` (create)
immediately followed by `GET /api/platform/profile 200` on first login.

### 5. Default-project core pages: Table Editor (read+write), SQL Editor (`select 1`), Database, Auth, Storage, Logs

**PASS — with one real bug found and fixed along the way** (see "Fix applied during this task"
below; not a substitution, the feature now genuinely works end-to-end).

- **SQL Editor:** ran the pre-existing on-disk snippet ("Untitled query 207",
  `pg_available_extensions` query) — 80 rows returned. Then ran `select 1 as m1_check;` — result
  `m1_check = 1, 1 row`. Screenshots: `task12-evidence-05a-sql-editor.png` (clean load),
  `task12-evidence-05b-sql-run-success.png` (extensions query result).
  **Pre-fix, this failed** with a client-side toast `"Unable to run query: Connection string is
  missing"` for every query, new or pre-existing — see fix below.
- **Table Editor (read):** created `m1_acceptance_test(id serial pk, note text)` + seed row via
  SQL Editor; Table Editor sidebar and grid showed it correctly (`id=1, note='seed'`).
  Screenshot: `task12-evidence-05c-table-editor.png`.
- **Table Editor (write):** used the UI's "Insert row" panel to insert a second row
  (`note='inserted-via-table-editor'`) — all `pg-meta` network calls 200'd. Verified independently:
  ```
  $ docker exec supabase-db psql -U postgres -d postgres -c "select * from m1_acceptance_test order by id;"
   id |           note
  ----+---------------------------
    1 | seed
    2 | inserted-via-table-editor
  (2 rows)
  ```
  Screenshot: `task12-evidence-05g-table-editor-write-confirmed.png`. (Test table dropped after
  verification: `drop table if exists m1_acceptance_test;` — confirmed via a following `\dt`-style
  check that the shared project DB was left clean.)
- **Database** (`/project/default/database/tables`): loads cleanly, lists `m1_acceptance_test`
  with correct column/row counts. Screenshot: `task12-evidence-05h-database.png`.
- **Auth** (`/project/default/auth/users`): loads cleanly, lists the underlying self-hosted
  project's GoTrue users ("Total: 10 users (estimated)") — correctly the *project's* auth users,
  distinct from platform-auth's dashboard users. Screenshot: `task12-evidence-05i-auth.png`.
- **Storage** (`/project/default/storage/buckets`): loads cleanly, empty-state "Create a file
  bucket" UI. Screenshot: `task12-evidence-05j-storage.png`.
- **Logs** (`/project/default/logs/edge-logs`): loads cleanly, full collections sidebar (API
  Gateway, Postgres, PostgREST, Pooler, Auth, Storage, Realtime, Edge Functions, Cron).
  Screenshot: `task12-evidence-05k-logs.png`.

**Fix applied during this task** (real, reviewed, tested — not a workaround): SQL Editor reads its
active connection string from `databases[].connectionString`
(`SQLEditor.tsx`'s `isValidConnString` gate on `databaseSelectorState.selectedDatabaseId`), which
comes from `pages/api/platform/projects/[ref]/databases.ts` — a pre-existing, non-`IS_PLATFORM`-
gated route that hardcoded `connectionString: ''`. This is the exact same defect class as Concern 3
from Task 11 (fixed on the sibling `projects/[ref]/index.ts` in the interstitial fix task), just on
a route the interstitial task's live walk didn't happen to exercise (Table Editor and the
project-overview call don't read `databases.ts`; only SQL Editor's query-run path does). Fixed by
mirroring the exact same pattern: branch on `IS_SELF_PLATFORM`, return
`encryptString(getConnectionString({ readOnly: false }))` instead of `''`; plain self-hosted
keeps the historical `''` byte-identical. TDD: RED (`databases.test.ts`, `handler` not exported —
`TypeError: handler is not a function`, 3/3 failing) → GREEN (3/3 passing, includes an assertion
that plain self-hosted's `connectionString` stays `''`) → live-verified (SQL Editor query runs
succeed end-to-end, see above). Typecheck and lint clean. Committed separately from this doc:
`c8a0992386 fix(studio): fix SQL Editor connection string gap in self-platform mode`.

**Separately observed, not fixed (out of this task's charter, non-blocking):**
`POST /api/platform/profile/audit-login` → 404 on every login (real pre-existing call from
`SignInForm.tsx`/`sign-in-mfa.tsx` via `data/misc/audit-login-mutation.ts`, no matching
`pages/api/platform/profile/audit-login.ts` route exists). Fire-and-forget — login and every
subsequent flow tested in this record proceeded correctly despite the 404. Flagged here as a small
follow-up gap for a future task, consistent with the "record concerns, don't silently expand scope"
pattern established in Task 11.

### 6. Logout → back to sign-in; re-login works

**PASS.** Used the account-menu "Log out" item — landed on `http://localhost:8082/sign-in`
(screenshot: `task12-evidence-06b-logged-out.png`). Re-entered the same credentials, "Sign in"
showed a loading state (`task12-evidence-06c-relogin.png`) then landed back on
`http://localhost:8082/organizations`.

### 7. MFA/TOTP: enroll → logout → re-login → MFA challenge → pass

**PASS.** Enrolled a TOTP app via `/account/security` → "Add new app" → "Generate QR". Extracted
the base32 secret from the enrollment panel's "enter this secret key" text (no QR image decoding
needed, the secret is present as plain text in the DOM for manual-entry accessibility). Generated
a 6-digit code with a throwaway inline Node script (`.superpowers/sdd/totp.mjs` — RFC 6238 HMAC-
SHA1 TOTP, `node:crypto` only) and submitted it — `"Successfully added a second factor
authentication"`, "1 app configured" (screenshot: `task12-evidence-07a-mfa-enrolled.png`). Logged
out, re-signed-in with the same email/password: **landed on `/sign-in-mfa`** (the MFA challenge
page), not directly on `/organizations` (screenshot: `task12-evidence-07b-mfa-challenge.png`).
Generated a fresh code from the same secret/script and submitted it — landed on
`http://localhost:8082/organizations` (screenshot: `task12-evidence-07c-mfa-passed.png`). The
resulting session JWT's claims confirm the elevated assurance level:
`"aal":"aal2","amr":[{"method":"totp",...},{"method":"password",...}]`.

### 8. API auth floor: `/api/platform/profile` 401 unauthenticated, 200 with a real token

**PASS.**

```
$ curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8082/api/platform/profile
401

$ curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8082/api/platform/profile \
    -H "Authorization: Bearer $TOKEN"   # $TOKEN = access_token pulled live from the
                                         # browser's localStorage['supabase.dashboard.auth.token']
200

$ curl -s http://localhost:8082/api/platform/profile -H "Authorization: Bearer $TOKEN"
{"id":2,"gotrue_id":"fcd332bd-...","auth0_id":"email|fcd332bd-...","username":"m1-acceptance",
 "primary_email":"m1-acceptance@internal.test","first_name":null,"last_name":null,"mobile":null,
 "is_alpha_user":false,"is_sso_user":false,"free_project_limit":10,"disabled_features":[]}
```

### 9. Plain self-hosted regression (zero-breakage check)

**PASS.** Backed up the platform profile (`.env.local.platform.bak`), swapped in
`.env.local.selfhosted.bak` (the exact byte-identical pre-Task-12 self-hosted profile, `md5
f842388791c54366fdb5d7bd7a6cb0a4`), cleared `.next`, restarted `pnpm dev:studio`.

- **johndoe stub:** `curl -s http://localhost:8082/api/platform/profile` (no auth header, no
  middleware gate in this mode) → 200, body is the hardcoded
  `{"id":1,"primary_email":"johndoe@supabase.io","username":"johndoe",...,"connectionString":""}`
  shape, byte-identical to the pre-platform-mode default.
- **`/project/default` direct access:** `curl -s -o /dev/null -w "%{http_code}"
  http://localhost:8082/project/default` → 200 (no redirect to `/sign-in` — direct access intact).
  Confirmed visually too: headless-browser navigation landed straight on the Default Project
  overview page, no login gate. Screenshot: `task12-evidence-09-selfhosted-regression.png`.

Swapped back to the platform profile afterward (`.env.local.platform.bak` → `.env.local`,
verified via `md5` matching what was active before the swap), cleared `.next` again, restarted,
and re-confirmed the platform profile is active (`GET /project/default` → 200 direct page load but
still client-redirects unauthenticated per item 1; `GET /api/platform/profile` unauthenticated →
401 again, not the johndoe stub). Dev server killed at the end of this task (`pkill -f "next dev -p
8082"` / `turbo run dev --filter=studio`) — port 8082 free.

### Summary

**9/9 PASS.** One real, previously-undiscovered bug was found and fixed during item 5 (SQL
Editor's `databases.ts` connection-string gap — see above), with its own RED/GREEN unit test and
live re-verification, committed separately from this doc. No other code changes were made during
acceptance; all other items passed against the code as it stood at the start of this task.
