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

| Path                                                            | Status | Frontend hook (file)                                                                                                                          | First seen at               |
| --------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `/api/platform/notifications?offset=0&limit=20&status=new,seen` | 404    | `data/notifications/notifications-v2-query.ts`                                                                                                | pre-login boot (`/sign-in`) |
| `/api/platform/telemetry/feature-flags`                         | 404    | `packages/common/feature-flags.tsx` (`getFeatureFlags`, called by `useFeatureFlags`/`FeatureFlagProvider`, exposed via `hooks/ui/useFlag.ts`) | pre-login boot              |
| `/api/platform/profile`                                         | 404    | `data/profile/profile-query.ts` (via `lib/profile.tsx` `ProfileProvider`)                                                                     | post-login (`/org`)         |
| `/api/platform/profile/permissions`                             | 404    | `data/permissions/permissions-query.ts` (via `ProfileProvider`'s `usePermissionsQuery`)                                                       | post-login                  |
| `/api/platform/stripe/invoices/overdue`                         | 404    | `data/invoices/invoices-overdue-query.ts`                                                                                                     | post-login                  |
| `/api/platform/projects/default`                                | 404    | `data/projects/project-detail-query.ts` (via `hooks/misc/useSelectedProject.ts`)                                                              | `/project/default`          |
| `/api/platform/projects/default/databases`                      | 404    | `data/read-replicas/replicas-query.ts`                                                                                                        | `/project/default`          |
| `/api/platform/projects/default/billing/addons`                 | 404    | `data/subscriptions/project-addons-query.ts`                                                                                                  | `/project/default`          |
| `/api/platform/telemetry/feature-flags?project_ref=default`     | 404    | `packages/common/feature-flags.tsx` (same hook, project-scoped call)                                                                          | `/project/default`          |
| `/api/v1/projects/default/network-bans/retrieve` (POST)         | 404    | `data/banned-ips/banned-ips-query.ts`                                                                                                         | `/project/default`          |

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

## Files changed / restored

- `apps/studio/.env.local` — temporarily overridden for the spike, restored byte-identical to
  the pre-spike backup (verified via `md5`) before committing this doc.
- `docs/self-hosted-parity/2026-07-02-M1-spike-findings.md` — this file (committed).
