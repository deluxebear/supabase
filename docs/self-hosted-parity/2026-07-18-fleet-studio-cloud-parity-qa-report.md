# Fleet Studio Cloud-Parity QA Report

| Field | Value |
| --- | --- |
| Date | 2026-07-18 (session wall clock; host TZ Asia/Shanghai) |
| Branch | `custom/main` |
| Environment | Local Fleet control plane + 2 managed stacks |
| Studio URL | `http://192.168.50.149:8001` (canonical origin; `localhost:8001` hits CORS) |
| Profile | Fleet (`NEXT_PUBLIC_STUDIO_DEPLOYMENT_PROFILE=fleet`, `IS_PLATFORM` + `SELF_PLATFORM`) |
| Projects under test | `project-a` (gateway `:8200`), `project-b` (gateway `:8300`) |
| Operator account | `admin@internal.test` (Owner, MFA TOTP enabled) |
| Evidence dir | `docs/self-hosted-parity/qa-evidence/2026-07-18/` |
| Route crawl dump | `qa-evidence/2026-07-18/route-crawl.jsonl` (91 routes) |
| Alignment baseline | `2026-07-16-current-feature-inventory-and-alignment-matrix.md` |

## 1. Executive summary

This QA pass exercises the Fleet multi-instance Studio against the Supabase Cloud product surface (and the fork’s documented Fleet contract). Testing used a headless Chromium browser session plus direct data-plane API checks against the attached stacks.

### Headline scores

| Area | Result | Notes |
| --- | --- | --- |
| Platform identity (login / MFA / org / team) | **PASS** | Password + TOTP works; org list shows 2 projects |
| Multi-project registry & project home health | **PASS** | Both projects `ACTIVE_HEALTHY`; home shows Healthy |
| Database browser / SQL Editor | **PASS** | SQL `version()` OK; table create + row browse OK |
| Auth (project users & config pages) | **PASS** | Users list, add-user UI, providers/config pages load |
| Storage | **PASS** | UI list + API create bucket/upload; UI reflects API |
| REST data plane | **PASS** | service_role CRUD path works on project-a |
| Edge Functions UI | **PASS (empty ready)** | Deploy via Editor/CLI CTAs present; no deploy exercised end-to-end |
| Realtime Inspector | **PASS (page)** | Join-channel UI loads |
| Logs Explorer | **DEGRADED** | Page loads; analytics endpoints 404 when Logflare not wired |
| Observability / reports | **DEGRADED** | Shell loads; charts/metrics often 404/500 |
| Backups / PITR | **PASS (honest degrade)** | Explicit “Backup management is offline” with remediation |
| Infrastructure / lifecycle | **PASS (honest degrade)** | `runtime.observe` unavailable; lifecycle provider unavailable |
| Fleet management targets | **PASS** | Local Fleet Management active; secrets redacted |
| Attach / New project wizard | **FAIL** | `/new/project` shows `Organization not found` |
| Billing / commercial Cloud pages | **HIDDEN / partial** | Matches product boundary; some routes empty or redirect oddly |
| Account audit logs | **FAIL** | API error retrieving account audit logs |
| Origin/CORS host consistency | **FAIL (config)** | `localhost` vs LAN IP mismatch breaks session API calls |
| GraphQL | **N/A (disabled)** | Data plane returns `pg_graphql extension is not enabled` (PG17 default) |

**Overall release judgment for this environment:** core data-plane Studio features for attached projects are usable. Fleet management honest-degradation paths behave as designed for offline Backup Operator / incomplete Agent capabilities. Blockers for “full Cloud-parity dogfood” are (1) new-project attach wizard org resolution, (2) observability/log analytics backend wiring, (3) canonical Studio origin CORS, (4) account-level audit API, and (5) incomplete runtime lifecycle capability advertisement on this Agent.

Route crawl: **91 routes** → **73 pure PASS**, **18 with console/network issues**, **1 hard page FAIL** (`/database/columns` is a non-existent route), **1 DEGRADED page** (infrastructure inventory).

---

## 2. Test environment topology

```
Browser ──► Fleet Studio (fleet-control-studio via Kong :8001)
              ├── platform-auth (GoTrue) + platform-db
              ├── Fleet Control (:8090–8092)
              └── Backup Operator (:8080 / TLS)

Studio project registry
  ├── project-a ──► Kong :8200 ──► db/auth/rest/storage/realtime/functions/meta/pooler
  └── project-b ──► Kong :8300 ──► same stack family
```

Containers observed healthy for both managed stacks and the control plane (Studio, gateway, platform-db, platform-auth, fleet-control, backup-operator, outbox dispatcher, agents).

### Access notes (critical)

1. **Use the canonical host printed by bootstrap** (`192.168.50.149:8001` here). Opening Studio on `http://localhost:8001` causes CORS failures against `http://192.168.50.149:8001/api/...` because Kong returns `Access-Control-Allow-Origin: *` with credentialed requests.
2. Admin requires **MFA TOTP** after password login.
3. Platform API without session cookies returns **401** as expected (`/api/platform/projects`, `/api/platform/organizations`).

---

## 3. Scope & method

### In scope (Cloud-comparable Studio product surface)

- Organizations, team/RBAC, project list
- Project Overview / Connect
- Table Editor, SQL Editor
- Database (schemas, tables, roles, extensions, policies, publications, triggers, functions, migrations, backups, settings)
- Authentication (users, providers, templates, MFA, sessions, hooks, SMTP, rate limits, protection, URL config)
- Storage (files, policies, settings, vectors, analytics)
- Edge Functions
- Realtime Inspector / settings
- Advisors (security / performance)
- Observability / reports
- Logs explorer + service log routes
- Integrations (Data API docs, Vault, wrappers redirect)
- Project settings (general, infrastructure, API keys, JWT, log drains, add-ons, integrations, billing redirects)
- Branches
- Org settings (general, team, SSO, audit, apps, management targets, billing/usage)
- Account (preferences, tokens, security, audit)
- Fleet attach wizard (`/new/project`)
- Data-plane REST / Auth admin / Storage / GraphQL smoke on project gateways

### Out of scope / not fully exercised

- Destructive restore / PITR execute (Backup Operator offline; intentionally not forced)
- Full Edge Function deploy + invoke through Fleet Agent (Agent reported offline on settings general)
- Realtime websocket channel traffic beyond inspector UI load
- Multi-user invitation email end-to-end (SMTP/Mailpit not validated)
- Production DR drills, migration checksum gate scripts (covered by separate release gates)
- Upstream Embedded/CLI single-stack profile (this run is Fleet only)

### Method

1. Browser login with password + TOTP
2. Automated crawl of 91 Studio routes (text, console errors, network 4xx/5xx, selective screenshots)
3. Deep interactive checks on SQL, Table Editor, Auth, Storage, Functions, Backups, Infrastructure, Management Targets, Attach wizard, Account
4. Direct Kong data-plane API smoke with project-a demo JWT keys; project-b with stack-specific keys

---

## 4. Detailed results by capability

Status key:

- **PASS** — works for intended user outcome
- **PASS*** — page works with non-blocking console/network noise
- **DEGRADED** — usable shell but core data missing or backend errors
- **HONEST** — intentionally unavailable with clear remediation (Fleet contract)
- **FAIL** — broken / false success / opaque error
- **HIDDEN** — commercial Cloud capability intentionally not offered
- **N/A** — not applicable in this topology

### 4.1 Platform identity & multi-org

| Case | Result | Evidence / notes |
| --- | --- | --- |
| Sign-in page loads | PASS | `/sign-in` form + GitHub/SSO CTAs |
| Password login | PASS | Redirects to `/sign-in-mfa` |
| MFA TOTP | PASS | Completes to `/organizations` |
| Organizations list | PASS | Default Organization · Enterprise · 2 projects |
| Org home projects | PASS | Managed Project A/B, Self-hosted \| local |
| Team members | PASS* | Owner `admin@internal.test`, MFA Enabled; SSO endpoint 404 noise |
| Invite members UI | PASS (UI) | Invite CTA present; email delivery not verified |
| Org general settings | PASS | Name/slug/lifecycle controls visible |
| Org SSO page | DEGRADED | Page shell loads; `GET .../organizations/default/sso` → 404 |
| Org audit logs | DEGRADED | Page shell loads; audit API 404 |
| Org billing | HIDDEN / partial | “Looking for something?” empty state on `/org/default/billing` |
| Org usage | PASS (page) | Loads usage shell |
| Account preferences | PASS | Profile, theme, shortcuts |
| Account access tokens | PASS | Generate token UI |
| Account security / MFA management | PASS | Backup method warning present |
| Account audit logs | FAIL | “Failed to retrieve audit logs” API error |
| Language switcher (zh-CN) | NOT FOUND | No Language/中文 control on Account Preferences in this build/session |

### 4.2 Project home & multi-instance isolation

| Case | Result | Evidence / notes |
| --- | --- | --- |
| project-a overview | PASS* | Status **Healthy**, URL `http://192.168.50.149:8200` |
| project-b overview | PASS* | Status Healthy, URL `:8300` |
| Service health dimensions | PASS | Home health green; advisor issues surface after table create |
| GitHub connection | DEGRADED/HIDDEN | `integrations/github/connections` → 404 (expected without GitHub integration) |
| Compute metrics on home | DEGRADED | CPU/Disk/RAM show **0%** / Compute **Unknown** |
| Distinct project JWT secrets | PASS | project-a demo keys ≠ project-b keys; cross-key REST fails as expected |

### 4.3 Database & SQL

| Case | Result | Evidence / notes |
| --- | --- | --- |
| SQL Editor open | PASS | Monaco, role `postgres`, limit 100 |
| Run `select version()` | PASS | PostgreSQL **17.6**, db `postgres`, user `postgres` |
| Create table via direct SQL (DB) | PASS | `public.qa_smoke` + 2 rows |
| Table Editor lists `qa_smoke` | PASS | Appears under schema `public` |
| Browse rows in Table Editor | PASS | Rows `qa-row-1`, `qa-row-2` visible; RLS disabled badge |
| Database → Tables | PASS | Shows `qa_smoke` |
| Schemas / Roles / Extensions / Policies / Publications / Triggers / Functions / Indexes / Migrations / Settings | PASS | Routes load without app crash |
| Database → Columns (direct URL) | FAIL (invalid route) | `/database/columns` → Next.js 404 (not a product nav entry) |
| Advisors security | PASS | Flags **CRITICAL RLS Disabled** on `public.qa_smoke` after create |
| Wrappers route | PASS | Redirects to Integrations wrappers category |

### 4.4 Authentication (project)

| Case | Result | Evidence / notes |
| --- | --- | --- |
| Users list (empty then populated) | PASS | After Admin API create, `qa-user@example.test` listed |
| Add user UI | PASS | Dialog opens |
| Auth providers | PASS | Sign-in / providers configuration page loads |
| Templates / SMTP / URL config / MFA / Sessions / Rate limits / Protection / Hooks | PASS | All load |
| Third-party auth config API | DEGRADED | UI loads; `config/auth/third-party-auth` → 404 |
| Policies shortcut | PASS | Redirects to Database policies |
| Auth admin API list/create | PASS | GoTrue `v2.189.0`; create user 200 |

### 4.5 Storage

| Case | Result | Evidence / notes |
| --- | --- | --- |
| Buckets page | PASS | Empty → then shows `qa-bucket` after API create |
| New bucket UI | PASS | Create dialog opens |
| Policies / settings / vectors / analytics pages | PASS | Load |
| API: list / create bucket / upload / list objects | PASS | Full smoke success on project-a `:8200` |

### 4.6 REST / GraphQL / Realtime / Functions (data plane)

| Case | Result | Evidence / notes |
| --- | --- | --- |
| REST service_role `qa_smoke` select | PASS | Returns 2 rows |
| REST anon select without RLS | PASS* / security note | Also returns rows (Advisor correctly flags public table) |
| Auth health | PASS | GoTrue healthy |
| Storage pipeline | PASS | See §4.5 |
| GraphQL | N/A | `pg_graphql extension is not enabled` (PG17 self-host default) |
| Functions gateway without name | Expected 400 | `missing function name in request` |
| Edge Functions Studio list | PASS (ready) | Deploy via Editor / AI / CLI CTAs |
| Realtime Inspector UI | PASS | Role postgres, Start listening |
| Realtime root HTTP | N/A | `/realtime/v1/` bare GET 404 (not a REST resource) |
| project-b REST with own keys | PASS | Swagger for public schema returned |

### 4.7 Logs & observability

| Case | Result | Evidence / notes |
| --- | --- | --- |
| Logs explorer shell | PASS | Collections listed (API Gateway, Postgres, Auth, Storage, …) |
| Unified logs promo | PASS (UI) | Banner present |
| Analytics `logs.all` queries | DEGRADED | Many 404 from `/api/platform/projects/.../analytics/endpoints/logs.all` |
| Observability API overview | DEGRADED | Shell OK; chart queries 404 |
| Observability database | DEGRADED | `/api/platform/projects/project-a/disk` → **500** |
| Observability storage | FAIL-ish | Requests incorrectly hit `projects/default/...` in some calls (wrong ref) |
| Query performance | PASS (page) | Loads |
| Log drains settings | DEGRADED | `analytics/log-drains` → 404 |

### 4.8 Settings, keys, integrations, branching

| Case | Result | Evidence / notes |
| --- | --- | --- |
| General settings | PASS | Name, ref, org access, **Fleet attachment status** panel |
| Fleet attachment status fields | PASS (honest) | Attachment active · Data plane healthy · Management target online · **Fleet Agent offline** · Drift unknown · Operations idle |
| Infrastructure | HONEST | Unable to load runtime inventory — `runtime.observe` unavailable; lifecycle providers unavailable |
| API keys | PASS | Publishable + secret keys listed (`sb_publishable_*`, `sb_secret_*`) |
| JWT keys | PASS* | Page loads; legacy api-keys 404 noise |
| Vault secrets | PASS | Routes via Integrations Vault |
| Data API docs | PASS | Shows generated docs including `qa_smoke` |
| Integrations index | PASS | Loads |
| Branches | DEGRADED / gated | Page loads; GitHub connections 404 (branching optional/gated) |
| Billing subscription redirect | HIDDEN | Redirects toward org billing placeholder |
| Add-ons / compute-and-disk | PASS (page) | Cloud commercial controls may be inert in Fleet |

### 4.9 Backups & PITR (Fleet Backup Operator path)

| Case | Result | Evidence / notes |
| --- | --- | --- |
| Scheduled backups page | HONEST | “Backup management is offline… Check management target, Agent, TLS, Operator health” + reference id + link to trust settings |
| PITR page | HONEST | Same offline state, separate correlation id |
| No opaque 404 | PASS | Matches release gate: honest correlated state instead of false success |

### 4.10 Fleet management plane

| Case | Result | Evidence / notes |
| --- | --- | --- |
| Management Targets list | PASS | **Local Fleet Management** · active · fleet.internal |
| Endpoint display | PASS | backup-operator `https://backup-operator-tls:8443 (v1)`, fleet-control `https://fleet-control:8091 (v1)` |
| Secret handling | PASS | CA `file:/run/secrets/...`, assertion `env:FLEET_MANAGEMENT_ASSERTION_PRIMARY` — secrets not pasted back |
| Add target form | PASS (UI) | Present with trust domain / CA / assertion / audience fields |
| Attach wizard `/new/project` | **FAIL** | “Failed to load attachment setup — Organization not found” |
| Runtime inventory API | HONEST | 409 Conflict when capability missing (surfaced in UI) |

### 4.11 i18n (zh-CN fork)

| Case | Result | Evidence / notes |
| --- | --- | --- |
| UI language during session | EN | All sampled pages English |
| Account language preference | NOT FOUND | Appearance/theme only; no locale control observed |

---

## 5. Route crawl matrix (91)

Summary:

| Bucket | Count |
| --- | --- |
| Pure PASS | 73 |
| PASS + console/network noise | 16 |
| DEGRADED | 1 (`settings/infrastructure` inventory) |
| FAIL page | 1 (`database/columns` 404 — invalid path) |

Notable non-pure routes (see `route-crawl.jsonl` for full text/errors):

| Path | Status | Primary issue |
| --- | --- | --- |
| `/project/project-a` | PASS* | GitHub connections 404 |
| `/project/project-a/database/columns` | FAIL | Next 404 |
| `/project/project-a/auth/third-party` | PASS* | third-party-auth API 404 |
| `/project/project-a/observability/*` | PASS* / DEGRADED | analytics 404; disk 500; storage wrong ref |
| `/project/project-a/settings/infrastructure` | DEGRADED | runtime-inventory 409 |
| `/project/project-a/settings/jwt` | PASS* | legacy api-keys 404 |
| `/project/project-a/settings/log-drains` | PASS* | log-drains 404 |
| `/project/project-a/branches` | PASS* | GitHub 404 |
| `/org/default/team` | PASS* | SSO 404 |
| `/org/default/audit` | PASS* | audit API 404 |
| `/org/default/sso` | PASS* | SSO 404 |
| project-b home | PASS* | GitHub 404 |

All other listed product routes (editor, SQL, database suite, auth suite, storage, functions, realtime, advisors, logs service pages, integrations, settings general/api-keys, org projects, etc.) pure PASS at crawl time.

---

## 6. Data-plane smoke evidence (project-a `:8200`)

| Check | HTTP | Result |
| --- | --- | --- |
| `GET /rest/v1/qa_smoke` service_role | 200 | 2 rows |
| `GET /rest/v1/qa_smoke` anon | 200 | 2 rows (no RLS — intentional smoke table) |
| `GET /auth/v1/health` | 200 | GoTrue v2.189.0 |
| `GET /auth/v1/admin/users` | 200 | list works |
| `POST /auth/v1/admin/users` | 200 | created `qa-user@example.test` |
| `GET /storage/v1/bucket` | 200 | [] then later includes `qa-bucket` |
| `POST /storage/v1/bucket` | 200 | `qa-bucket` |
| `POST /storage/v1/object/qa-bucket/hello.txt` | 200 | uploaded |
| `POST /storage/v1/object/list/qa-bucket` | 200 | `hello.txt` |
| `POST /graphql/v1` | 200 body error | pg_graphql disabled |

project-b `:8300` with **its own** service key: REST openapi + Auth health OK.

---

## 7. Defects & findings (prioritized)

### P0 — blocks core multi-project operations

1. **Attach / New project wizard cannot load setup**  
   - Repro: open `/new/project` while logged in as Owner.  
   - Symptom: `Failed to load attachment setup` / `Organization not found`.  
   - Impact: cannot attach additional stacks from UI.

### P1 — wrong host / CORS footgun

2. **Studio must be opened on the configured public origin**  
   - `localhost:8001` vs `192.168.50.149:8001` causes credentialed CORS failures (`Access-Control-Allow-Origin: *`).  
   - Impact: silent broken session/API after login if operators bookmark the wrong host.  
   - Related memory: central Studio canonical origin CORS work (2026-07-16).

### P1 — observability / analytics incomplete on this deployment

3. **Logs analytics endpoints 404** (`logs.all`) across Observability & Reports.  
4. **Disk endpoint 500** on `/api/platform/projects/project-a/disk`.  
5. **Storage observability sometimes queries `projects/default`** instead of `project-a` (wrong ref regression risk).  
6. Home compute metrics stuck at 0% / Unknown.

### P2 — Cloud parity gaps / incomplete platform APIs

7. Org SSO / Org audit / Account audit APIs return 404 or error (pages still render shells).  
8. Third-party auth config API 404.  
9. Log drains API 404.  
10. Legacy JWT/api-keys endpoints 404 (new key model partially present).  
11. GitHub integration endpoints 404 (branching/GitHub features gated).  
12. Billing pages intentionally empty / “page not found” style placeholders.

### P2 — capability honesty (expected but incomplete for full lifecycle)

13. **Fleet Agent offline** on project settings while data plane healthy — Edge deploy / runtime inventory / lifecycle remain gated.  
14. Backup Operator domain **offline** — backups/PITR correctly blocked with remediation (good).  
15. `runtime.observe` unavailable → infrastructure inventory honest fail.

### P3 — product polish / test hygiene

16. `/database/columns` is not a real route (404). Should not be linked; crawl-only issue.  
17. Auth users empty state vs “Total: 10 users (estimated)” copy inconsistency when zero/few users.  
18. SQL multi-statement create via Monaco was flaky in browser automation; single statements / direct DB DDL reliable.  
19. No visible zh-CN language switcher in Account Preferences during this session.  
20. Headless Chromium warns `Navigator Locks API` unsupported (benign for GoTrue lock).

### Security observation (expected for smoke table)

21. Created `public.qa_smoke` without RLS → Advisor **CRITICAL** correctly fired; anon REST could read rows. This validates Advisors + REST, not a product defect — clean up after QA:

```sql
drop table if exists public.qa_smoke;
-- also optional: delete auth user qa-user@example.test; remove storage bucket qa-bucket
```

---

## 8. Cloud vs Fleet parity checklist (this run)

Mapped to `2026-07-16-current-feature-inventory-and-alignment-matrix.md`:

| Capability | Cloud expectation | Fleet result this run |
| --- | --- | --- |
| Multi org/project | Aligned | **PASS** (1 org, 2 projects) |
| MFA for operator | Aligned | **PASS** (TOTP) |
| Project RBAC | Aligned | **PASS** (Owner visible; deeper role matrix not multi-user tested) |
| Attach existing stack | Fleet-specific | **FAIL** wizard load |
| Secrets redaction | Aligned | **PASS** (management targets) |
| DB browser / SQL | Direct | **PASS** |
| Auth users + config | Direct / gated runtime | **PASS** pages; runtime config not fully mutated |
| Storage | Direct | **PASS** |
| REST exploration | Direct | **PASS** (docs + REST) |
| GraphQL | Direct when enabled | **N/A** disabled extension |
| Realtime | Direct | **PASS** UI |
| Logs | Equivalent when configured | **DEGRADED** (no Logflare endpoint data) |
| Infra metrics | Equivalent | **DEGRADED** |
| Stack health | Aligned (stronger dims) | **PASS** overview Healthy; management dims partially unknown/offline |
| Edge Functions deploy | Gated Fleet path | **UI ready / Agent offline** — deploy not proven |
| Lifecycle restart/scale/upgrade | Gated | **HONEST unavailable** |
| Backups / PITR | Equivalent via Operator | **HONEST offline** |
| Branching | Optional gated | **UI shell / no GitHub** |
| Billing / regions / spend | Hidden | **HIDDEN** |

---

## 9. Evidence index

Directory: `docs/self-hosted-parity/qa-evidence/2026-07-18/`

| File pattern | Content |
| --- | --- |
| `02-organizations.png` | Org list after MFA |
| `03-org-home.png` | Two managed projects |
| `04-project-a-home.png` | Healthy project overview |
| `route-*.png` | Key route screenshots from crawl |
| `deep-sql-results.png` | SQL version() result grid |
| `deep4-table-rows.png` | Table Editor rows for `qa_smoke` |
| `deep4-storage-after-api.png` | `qa-bucket` in Studio |
| `deep4-auth-user.png` | Auth user listed |
| `deep-backups-*.png` | Offline backup honest state |
| `deep-infrastructure.png` | Runtime inventory / lifecycle unavailable |
| `deep3-mgmt-targets.png` | Management targets configuration |
| `deep3-new-project.png` | Attach wizard org-not-found failure |
| `route-crawl.jsonl` | Machine-readable 91-route results |

---

## 10. Recommended next actions

1. **Fix `/new/project` organization resolution** (P0) — cannot expand fleet from UI until fixed.  
2. **Document and enforce single public Studio origin** (CORS) — reject or redirect non-canonical hosts.  
3. **Wire or honestly hide Observability charts** when Logflare/Prometheus endpoints are absent (avoid raw 404/500 console spam).  
4. **Fix storage observability project ref** (`default` vs actual ref).  
5. **Bring Fleet Agent online** for project-a and re-test Edge Function deploy + runtime inventory + lifecycle preview.  
6. **Bring Backup Operator domain online** and run one scheduled backup + restore drill (release gate item 5).  
7. **Verify zh-CN switcher** path (or confirm fleet image builds without locale switch intentionally).  
8. Clean up QA artifacts (`qa_smoke`, `qa-user@example.test`, `qa-bucket`).  
9. Re-run this crawl script after fixes; keep `route-crawl.jsonl` as regression baseline.

---

## 11. Reproduction commands (operators)

```bash
# Browse / Studio
open "http://192.168.50.149:8001/sign-in"
# admin@internal.test + PLATFORM_ADMIN_PASSWORD + TOTP

# Data plane smoke (project-a demo keys from stack env)
export BASE=http://192.168.50.149:8200
export SERVICE="$(docker inspect supabase-managed-project-a-kong \
  --format '{{range .Config.Env}}{{println .}}{{end}}' | awk -F= '/^SUPABASE_SERVICE_KEY=/{print $2}')"
curl -sS -H "apikey: $SERVICE" -H "Authorization: Bearer $SERVICE" \
  "$BASE/rest/v1/qa_smoke?select=*"
```

Containers snapshot at test time included: `supabase-fleet-control-*`, `supabase-managed-project-a-*`, `supabase-managed-project-b-*`, fleet agents/observers.

---

## 12. Sign-off

| Role | Verdict |
| --- | --- |
| QA (this session) | **DONE_WITH_CONCERNS** |
| Usable for | Day-to-day management of already-attached projects (DB/SQL/Auth/Storage/API keys) |
| Not ready for | Greenfield attach of new stacks via UI; Cloud-grade observability/billing parity; full lifecycle/backup drills until Agent/Operator online |
| Confidence | High for Studio shell + project-a data plane; Medium for project-b (subset tested); Low for unenrolled lifecycle/backup execute paths |

**STATUS:** DONE_WITH_CONCERNS  
**REASON:** Core attached-project Studio/data-plane paths verified with evidence; P0 attach wizard failure and observability wiring gaps remain.  
**RECOMMENDATION:** Fix attach wizard + origin CORS first; then Agent/Operator online retest for Edge Functions, runtime inventory, and backups before claiming full Fleet release readiness.
