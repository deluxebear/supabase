# F9+F16 M4 — Project-level Auth config panel (design/spec)

Date: 2026-07-04
Milestone: M4 (self-hosted multi-team platform, `custom/main` fork)
Base: custom/main @8a666d4ee5 (M3.2 merged; M1→M3 complete)
Branch (planned): `feat/f9-f16-m4-auth-config`
Status: **RATIFIED** (user approved the 4 §0 decisions + always-mask on 2026-07-04)

---

## §0 Ratified decisions

The whole `/project/[ref]/auth` settings surface (~18 form components: Providers,
Emails/SMTP, URL config, Rate Limits, MFA, Attack Protection, Sessions, Hooks,
Audit Logs, Passkeys, OAuth Apps, Custom providers, …) is currently **404** because
`GET/PATCH /platform/auth/{ref}/config` (+ `/config/hooks`) has no route file.
M4 builds the truth-source store + routes + an apply channel.

| #   | Decision             | Choice (ratified)                                                                                                                                                          | Flip cost                                                                             |
| --- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| D1  | Apply channel scope  | **Store + CLI apply, both in M4** (end-to-end: store → CLI render env → restart GoTrue → live)                                                                             | Dropping apply → store-only MVP; apply becomes M4.1                                   |
| D2  | `06` table structure | **jsonb hybrid** — `config jsonb` (non-secret) + `secrets jsonb` (encrypted map)                                                                                           | Single-blob (secrets inline) or 237 columns (rejected)                                |
| D3  | GET seed/defaults    | **Curated defaults baseline ⊕ stored overrides**; GET returns full 237-field object                                                                                        | Lean sparse seed, or GoTrue `/settings` seed                                          |
| D4  | Apply target model   | **Shared-stack, config-driven target** (default = compose service `auth`; container_name `supabase-auth`); stack-scoped semantics documented                               | Per-project stack metadata in registry (deferred until real per-project stacks exist) |
| D5  | Secret read tier     | **Always-mask on GET** (no `secrets:Read` reveal tier) — UI treats every secret as write-only and never displays it, so decrypted secrets are never shipped to the browser | Two-tier `read:Read`/`secrets:Read` like the settings route                           |

**Load-bearing honesty boundary (must be documented in README + surfaced in the design):**
GoTrue reads its ~237 config vars from env **at boot**; there is no runtime config
read/write API. Therefore the stored config is **desired state**, not a live mirror,
and **"stored ≠ live until `apply-auth-config` is run"**. On a shared stack, auth config
and apply are effectively **stack-scoped** (one `supabase-auth` serves every project on
that stack); true per-project isolation requires per-project stacks (future work).

---

## §1 Context & problem

- Frontend already wired: every Auth settings page calls `useAuthConfigQuery`
  (`data/auth/auth-config-query.ts:22`) → `GET /platform/auth/{ref}/config`, with
  `enabled: IS_PLATFORM` (true in self-platform → the request really fires). Mutations
  go to `PATCH /platform/auth/{ref}/config` (`auth-config-update-mutation.ts`, body
  `UpdateGoTrueConfigBody`) and `PATCH /platform/auth/{ref}/config/hooks`
  (`auth-hooks-update-mutation.ts`, body `UpdateGoTrueConfigHooksBody`).
- `pages/api/platform/auth/[ref]/` has only `invite/magiclink/otp/recover/users`.
  `config.ts` and `config/hooks.ts` **have never existed** → every page 404s on open.
- **The essential difference from the Users panel:** Users proxies to a GoTrue admin
  API that _exists_. Auth **config** has no runtime GoTrue API — it is env-driven and
  read at boot. So M4 is **not a proxy**; it is a config store + apply mechanism.

## §2 Contract (single source of truth: `packages/api-types/types/platform.d.ts`, read-only)

Three types, all under `components['schemas']`:

- **`GoTrueConfigResponse`** (GET response) — **237 fields**, `platform.d.ts:7782–8050`.
  Effectively all required. Flat env-mirror scalars **except 2 nested read-only objects**
  (`MAILER_SUBJECTS_CUSTOM_CONTENTS`, `MAILER_TEMPLATES_CUSTOM_CONTENTS`, 13 booleans each).
  1 enum: `DB_MAX_POOL_SIZE_UNIT: 'connections'|'percent'|null`.
- **`UpdateGoTrueConfigBody`** (PATCH body) — **239 fields**, `platform.d.ts:11793–12044`.
  Every field optional + nullable, fully flat. 4 enums (see below).
- **`UpdateGoTrueConfigHooksBody`** (hooks PATCH body) — **21 fields**, `platform.d.ts:12045+`.
  7 hooks × {`_ENABLED`, `_SECRETS`, `_URI`}. A strict subset of the main config's `HOOK_*`.

**Field-set drift (must be handled explicitly):**

- Response-only (3, not writable): `CUSTOM_OAUTH_MAX_PROVIDERS`, `MAILER_SUBJECTS_CUSTOM_CONTENTS`,
  `MAILER_TEMPLATES_CUSTOM_CONTENTS`. → served from `DEFAULTS`, never written, never applied.
- Body-only (5, writable but not in GET response): `EXTERNAL_WORKOS_ENABLED`,
  `EXTERNAL_X_{CLIENT_ID,EMAIL_OPTIONAL,ENABLED,SECRET}`. → persisted on PATCH; **write-through
  only** (not surfaced by GET, since the response type lacks them); `EXTERNAL_X_SECRET` joins
  the secret set for storage/apply.

**Enum asymmetry** (the sanctioned `as` exception applies only here): in the **response** these
are plain `string`; in the **body** they are narrowed unions:

- `PASSWORD_REQUIRED_CHARACTERS` (4 literals + `''` + `null`)
- `SECURITY_CAPTCHA_PROVIDER: 'turnstile'|'hcaptcha'|null`
- `SMS_PROVIDER: 'messagebird'|'textlocal'|'twilio'|'twilio_verify'|'vonage'|null`
- `DB_MAX_POOL_SIZE_UNIT` (both types).

**Secret fields — the frozen `SECRET_FIELDS` set (37 for storage/apply; 36 appear in GET):**

- 20 OAuth `EXTERNAL_*_SECRET`: `APPLE, AZURE, BITBUCKET, DISCORD, FACEBOOK, FIGMA, GITHUB,
GITLAB, GOOGLE, KAKAO, KEYCLOAK, LINKEDIN_OIDC, NOTION, SLACK_OIDC, SLACK, SPOTIFY, TWITCH,
TWITTER, WORKOS, ZOOM` — **plus body-only `EXTERNAL_X_SECRET`** (37th).
- 7 hook secrets: `HOOK_{AFTER_USER_CREATED, BEFORE_USER_CREATED, CUSTOM_ACCESS_TOKEN,
MFA_VERIFICATION_ATTEMPT, PASSWORD_VERIFICATION_ATTEMPT, SEND_EMAIL, SEND_SMS}_SECRETS`.
- 6 SMS creds: `SMS_MESSAGEBIRD_ACCESS_KEY, SMS_TEXTLOCAL_API_KEY, SMS_TWILIO_AUTH_TOKEN,
SMS_TWILIO_VERIFY_AUTH_TOKEN, SMS_VONAGE_API_KEY, SMS_VONAGE_API_SECRET`.
- 2 other: `SECURITY_CAPTCHA_SECRET`, `NIMBUS_OAUTH_CLIENT_SECRET`.
- 1 SMTP: `SMTP_PASS`.

**Explicitly NOT secrets** (do not over-match on suffix): `SECURITY_UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD`
(boolean toggle, ends in `_PASSWORD`), the 3 `PASSWORD_*` policy fields, and Twilio SIDs
(`SMS_TWILIO_*_SID` — identifiers, not credentials). No SAML private key / JWT signing key
exists in this contract (only `JWT_EXP`, `SAML_{ALLOW_ENCRYPTED_ASSERTIONS,ENABLED,EXTERNAL_URL}`).

**Frontend behavior that de-risks the write path** (verified):

- Forms send only changed fields: `if (data[param] !== authConfig?.[param]) payload[param] = data[param]`
  (`RateLimits.tsx:165`).
- Secrets are write-only: blank-initialized, and blank ones are deleted from the payload
  (`SmtpForm.tsx:148,180–183` — "cannot be viewed once saved"). The UI never round-trips a
  masked secret. So no-overwrite is mostly free; the backend only needs a **defensive** skip.
- Forms read config with `?.` guards → a missing field renders a default, never crashes. A full
  237-field GET is for correctness/predictability, not crash-safety.

## §3 Architecture & data flow

```
Studio Auth pages (~18 forms)  ── enabled: IS_PLATFORM ──►
   GET   /platform/auth/{ref}/config          (read gate: READ  custom_config_gotrue)
   PATCH /platform/auth/{ref}/config          (write gate: UPDATE custom_config_gotrue)
   PATCH /platform/auth/{ref}/config/hooks     (write gate: UPDATE custom_config_gotrue)
        │
        ▼
   pages/api/platform/auth/[ref]/config.ts, config/hooks.ts
        │   skeleton: !IS_SELF_PLATFORM→404 · method→405 · array-ref→400 · guardProjectRoute · business
        ▼
   lib/api/self-platform/auth-config.ts
        │   read : DEFAULTS ⊕ stored.config, mask every SECRET_FIELDS key to ''
        │   write: split secret/non-secret, encrypt secrets, skip masked/blank secrets
        ▼
   platform.auth_config   (platform-db; 06-auth-config.sql)
        │
   [operator]  tsx docker/scripts/platform/apply-auth-config.ts <ref>
        │   read row via docker exec psql · decrypt secrets · render GOTRUE_*=…
        │   write compose override · docker compose up -d <service=auth>
        ▼
   supabase-auth restarts with new env  ──►  config LIVE (stack-scoped)
```

## §4 `06-auth-config.sql` — the table

```sql
create table if not exists platform.auth_config (
  project_ref text primary key
    references platform.projects(ref) on delete cascade,
  config      jsonb not null default '{}'::jsonb,   -- non-secret stored overrides
  secrets     jsonb not null default '{}'::jsonb,   -- { <SECRET_FIELD>: <AES ciphertext>, ... }
  updated_at  timestamptz not null default now(),
  updated_by  text                                  -- gotrue sub of the admin who last saved
);
```

- Idempotent (`create table if not exists`; guard any grants/comments) — 04/05 precedent.
- Stores **only overrides**, never the full 237 fields.
- README "Upgrading an existing platform-db" gets a `06-auth-config.sql` paragraph
  (fenced bash, matching the 04/05-mfa entries).
- No seed row — a project's row is created lazily on first PATCH (upsert).

## §5 Data layer — `apps/studio/lib/api/self-platform/auth-config.ts`

Exports (all pure/testable; DB access via the existing platform-db query helper used by
`members.ts`/`organizations.ts`, parameterized `$n`):

- **`DEFAULTS: GoTrueConfigResponse`** — checked-in 237-field baseline. Values = GoTrue's
  documented defaults where known (`JWT_EXP: 3600`, rate-limit numerics, `MAILER_AUTOCONFIRM`,
  `URI_ALLOW_LIST: ''`, etc.); otherwise type-zero (`false`/`''`/`0`). The 2 nested
  `*_CUSTOM_CONTENTS` objects present with all-false sub-fields; `CUSTOM_OAUTH_MAX_PROVIDERS`
  a fixed numeric. Documented as "GoTrue documented defaults; unset ⇒ type-zero — this is a
  desired-state store, not a live-GoTrue mirror."
- **`SECRET_FIELDS: ReadonlySet<string>`** — the 37 names from §2. Single source of truth for
  masking + encryption + apply-decrypt. Unit test pins the exact membership (incl. exclusions).
- **`readAuthConfig(projectRef): Promise<GoTrueConfigResponse>`**
  1. Load the row (`config`, `secrets`); missing row ⇒ empty overrides.
  2. `merged = { ...DEFAULTS, ...config }`. (Secrets live in `secrets`, not `config`, so they
     stay at their `DEFAULTS` `''` — i.e. already blank.)
  3. For every `SECRET_FIELDS` key **that already exists in `merged`**, set it to `''` (mask —
     never decrypt for the API). Masking only present keys avoids adding the body-only
     `EXTERNAL_X_SECRET` (absent from `GoTrueConfigResponse`) as an off-contract extra field.
  4. Return `merged` typed as `GoTrueConfigResponse`.
- **`writeAuthConfig(projectRef, body: Partial<UpdateGoTrueConfigBody>, updatedBy?)`**
  1. Partition incoming keys into secret vs non-secret via `SECRET_FIELDS`.
  2. **No-overwrite:** drop any secret key whose value is `''`/`null`/undefined (masked/blank) —
     it must not clobber stored ciphertext. (Mirrors `SmtpForm`'s own `delete payload.SMTP_PASS`.)
  3. Encrypt each surviving secret value with `encryptSecret` (from `secrets.ts`).
  4. Upsert: `config = config || <non-secret patch>`, `secrets = secrets || <encrypted patch>`
     (jsonb concatenation merges/overwrites keys), `updated_at = now()`, `updated_by`.
     Parameterized; the patch objects passed as `$n::jsonb`.
  5. Return the re-read masked `GoTrueConfigResponse`.
- **`writeHookConfig(projectRef, body: Partial<UpdateGoTrueConfigHooksBody>, updatedBy?)`**
  Same as `writeAuthConfig` but scoped to the 21 `HOOK_*` keys (7 `HOOK_*_SECRETS` are in
  `SECRET_FIELDS`). Reuses the same partition/encrypt/no-overwrite/upsert helper internally.

**Enum handling:** writes store raw values as-is; the sanctioned enum-narrowing `as` is used only
where a response `string` field must be assigned to a body union type. No other `as any`.

## §6 Routes

Both files follow the **self-platform-only skeleton** (enforcement.ts pattern — _not_ the
recover.ts per-ref proxy-fallback pattern, because auth config has no plain-mode target):

```
export default (req, res) => apiWrapper(req, res, handler, { withAuth: true })
export async function handler(req, res, claims?) {
  if (!IS_SELF_PLATFORM) return res.status(404).json({ message: 'Not available on this deployment' })
  if (method not allowed) { res.setHeader('Allow', [...]); return res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } }) }
  if (Array.isArray(req.query.ref)) return res.status(400).json({ message: 'Invalid ref parameter' })
  ... guardProjectRoute ... business
}
```

- **`config.ts`** — methods `GET`, `PATCH`.
  - GET: `guardProjectRoute(res, claims, { action: PermissionAction.READ, projectRef, resource: 'custom_config_gotrue' })`
    → `readAuthConfig(ref)` → `200 GoTrueConfigResponse`.
  - PATCH: parse `body` as `Partial<UpdateGoTrueConfigBody>` →
    `guardProjectRoute(… action: PermissionAction.UPDATE, resource: 'custom_config_gotrue')`
    → `writeAuthConfig(ref, body, claims?.sub)` → `200` re-read masked config.
- **`config/hooks.ts`** — method `PATCH` only. Body `Partial<UpdateGoTrueConfigHooksBody>`;
  UPDATE `custom_config_gotrue` gate; `writeHookConfig`; `200` re-read masked config.
  (Next.js pages router allows `config.ts` + `config/hooks.ts` to coexist.)

**404-before-403 / unknown-ref / MFA** are all free: `guardProjectRoute` calls
`resolveProjectConnection(ref)` first (unknown ref ⇒ `ProjectNotFound` ⇒ apiWrapper 404) and
performs the aal2 MFA check before `checkPermission`.

**Zero-break (HARD):** sibling `config.self-hosted.test.ts` (+ hooks) assert that in plain mode
(`IS_SELF_PLATFORM` false) every method returns **byte-identical** `404 { message: 'Not available
on this deployment' }`. Because these are bracket routes, **all route tests live in the `tests/`
mirror, never colocated** (Turbopack collision rule, M3.1 lesson).

## §7 RBAC (no matrix change required)

Parity source of truth: the Auth pages themselves gate on `useAsyncCheckPermissions(READ|UPDATE,
'custom_config_gotrue')` (e.g. `OAuthServerSettingsForm.tsx:110`, `BasicAuthSettingsForm.tsx:66–71`,
all `pages/project/[ref]/auth/*.tsx`).

The server matrix (`lib/api/self-platform/rbac/matrix.ts`) grants base roles on resource `'%'`
(wildcard), so `custom_config_gotrue` is already covered — **no matrix edit**:

| Role          | READ `custom_config_gotrue` |             UPDATE (`write:Update`) `custom_config_gotrue`              |
| ------------- | :-------------------------: | :---------------------------------------------------------------------: |
| Owner         |         ✓ (`%`/`%`)         |                                    ✓                                    |
| Administrator |              ✓              |       ✓ (restrictive deny is only on `write:%` × `organizations`)       |
| Developer     |  ✓ (`READ_ACTIONS` on `%`)  | ✗ (`UPDATE` is in neither `READ_ACTIONS` nor `DEVELOPER_WRITE_ACTIONS`) |
| Read-only     |  ✓ (`READ_ACTIONS` on `%`)  |                                    ✗                                    |

Net: **any project member can view; only Owner/Admin can write** — the intended gate, matching
cloud behavior, verified against the matrix, achieved with zero server-side RBAC changes. A test
pins this (Owner/Admin PATCH → allowed; Developer/Read-only PATCH → 403).

## §8 Apply CLI — `docker/scripts/platform/apply-auth-config.ts`

Operator-run `tsx` CLI (register-project.ts precedent; Studio never controls docker):

```
apply-auth-config <ref> [--target <container>] [--dry-run]
```

1. Read `platform.auth_config` for `<ref>` via `docker exec -i <PLATFORM_DB_CONTAINER> psql`
   (stdin params, never argv — register-project.ts pattern). Decrypt `secrets.*` with
   `PLATFORM_ENCRYPTION_KEY` (`decryptSecret`).
2. Render one `GOTRUE_<FIELD>=<value>` line **only** for fields explicitly present in the stored
   `config` (real overrides) plus each decrypted secret from `secrets`. Fields supplied solely by
   `DEFAULTS` are **not** rendered — the base compose env already provides them, so apply layers
   only the operator's actual changes on top.
   - Mapping rule: **`GOTRUE_${fieldName}` verbatim** (verified: the API field names ARE the
     GoTrue env names minus the prefix — `SITE_URL`→`GOTRUE_SITE_URL`, `EXTERNAL_GITHUB_SECRET`
     →`GOTRUE_EXTERNAL_GITHUB_SECRET`, `SMTP_PASS`→`GOTRUE_SMTP_PASS`, `MFA_*`→`GOTRUE_MFA_*`).
     A small `ENV_NAME_OVERRIDES` map (empty at first; populated only if a live field disagrees).
   - Value formatting: booleans → `true`/`false`; numbers → decimal; string arrays
     (e.g. `URI_ALLOW_LIST`) → comma-joined; `null` → omit the line.
   - **Never render** the 3 read-only/computed response-only fields (2 nested `*_CUSTOM_CONTENTS`,
     `CUSTOM_OAUTH_MAX_PROVIDERS`) even if somehow present in `config`.
3. Write the rendered vars into a **compose override file**
   (`docker/docker-compose.auth-override.yml`, `services.<auth>.environment`) — self-contained,
   does not edit base compose or `.env`.
4. `docker compose -f docker-compose.yml -f docker-compose.auth-override.yml up -d <target>`
   where `target = --target || PLATFORM_AUTH_CONTAINER || 'auth'` (the docker-compose SERVICE KEY — `docker compose up -d`/-f merging resolve by service key; the container_name is `supabase-auth`). Idempotent
   (re-render + recreate). `--dry-run` prints the rendered override and skips the restart.

**Stack-scoped semantics (documented):** the target GoTrue is shared across every project on the
stack, so applying any ref's config restarts that shared GoTrue and takes effect stack-wide.

## §9 Security

- **Three-layer secret defense:** (1) encrypted at rest (`secrets` jsonb, `encryptSecret`);
  (2) masked on GET (`''`, write-only, never decrypted for the API); (3) no-overwrite on PATCH
  (masked/blank secret values are skipped) — plus **never committed to git**.
- **⚠ New plaintext-secret surface (call out loudly):** `apply-auth-config` renders **decrypted**
  `GOTRUE_*_SECRET` / `GOTRUE_SMTP_PASS` into `docker-compose.auth-override.yml`. That file must be
  **gitignored, `chmod 600`, and documented sensitive** (same class as `docker/.env`). The CLI
  prints a one-line warning; README states it; `.gitignore` covers the override file + any
  `*.auth-override.yml`. A secrets-not-in-git test/grep guard asserts no plaintext secret paths
  are tracked.
- Parameterized SQL (`$n`, jsonb patches as `$n::jsonb`); no `as any` except enum narrowing (§2);
  `IS_SELF_PLATFORM` gate; 404-before-403; fail-closed (`PLATFORM_ENCRYPTION_KEY` missing ⇒ throw);
  **zero new npm dependencies**.
- **MFA consistency:** routes flow through `guardProjectRoute` → the `checkPermissionWithContext`
  chokepoint (M3.2), so `enforce_mfa` protection is automatic; no re-implementation.

## §10 Hard constraints (铁律 — carry from M1→M3.2)

api-types is the only contract source (read-only); no `as any` except enum narrowing;
`IS_SELF_PLATFORM` gate; pure self-hosted **byte-identical zero-break** (siblings, fault-injectable);
error body top-level `{ message }` (405 uses nested `{ data: null, error: { message } }`); zero new
npm deps; 404 before 403; fail-closed; all SQL `$n`-parameterized; multi-step writes respect the M1
I1-BUG snapshot rule (N/A here — single upsert per write, no cross-statement visibility dependency).

## §11 Testing

**Unit (vitest):**

- `auth-config.ts`: `SECRET_FIELDS` membership (incl. exclusions); `readAuthConfig` merge +
  mask-all-secrets + missing-row → defaults; `writeAuthConfig` partition/encrypt/no-overwrite
  (masked-`''` secret does NOT overwrite ciphertext — fault-injectable RED), enum-safe write;
  `writeHookConfig` HOOK\_\* scoping + 7 hook secrets encrypted.
- `config.ts` / `config/hooks.ts`: skeleton (404/405/400), RBAC (Owner/Admin PATCH allowed,
  Developer/Read-only PATCH 403, all roles GET), GET masks secrets, PATCH round-trips,
  unknown-ref → 404. Bracket-route tests in `tests/` mirror.
- Sibling `*.self-hosted.test.ts`: plain-mode byte-identical 404 on every method.
- `apply-auth-config.ts`: arg parse; render (GOTRUE\_ mapping, bool/number/array formatting,
  skip read-only + unset, secret decrypt); `--dry-run` renders without restart; no secret
  in tracked files.

**Controller E2E (live `:8082` self-platform + `supabase-auth` via Kong `:8100` + `platform-db`):**

1. Open an Auth page (e.g. Rate Limits) as Owner → GET 200, forms render (no 404).
2. Change a non-secret field + a secret (e.g. `RATE_LIMIT_TOKEN_REFRESH` + an OAuth secret) → PATCH
   → psql-verify: non-secret in `config`, secret in `secrets` as **ciphertext** (not plaintext),
   `updated_by` set.
3. Re-GET → secret masked to `''`; save again without touching the secret → ciphertext preserved
   (no-overwrite proven live).
4. Developer PATCH → 403; Read-only PATCH → 403; Developer GET → 200.
5. `tsx apply-auth-config default` → `supabase-auth` recreated → verify the change is live
   (e.g. the rate-limit / a `DISABLE_SIGNUP` flip observably takes effect); confirm the override
   file holds the expected `GOTRUE_*` and is gitignored.
6. Unknown ref → 404; MFA on (`enforce_mfa`) + aal1 → 403 on GET/PATCH.
7. Plain self-hosted (both flags off + restart): route → 404 byte-identical; main stack independent.
   Restore flags; re-verify self-platform.

## §12 Task split (subagent-driven; controller maintains the ledger)

- **T1** `06-auth-config.sql` — `platform.auth_config` table (jsonb hybrid), idempotent + README
  upgrade paragraph; live-apply twice (idempotent) + partial verify.
- **T2** `lib/api/self-platform/auth-config.ts` — `DEFAULTS`, `SECRET_FIELDS`, `readAuthConfig`,
  `writeAuthConfig`, `writeHookConfig` + unit tests.
- **T3** `pages/api/platform/auth/[ref]/config.ts` — GET + PATCH; skeleton, RBAC, zero-break sibling,
  bracket tests in `tests/` mirror.
- **T4** `pages/api/platform/auth/[ref]/config/hooks.ts` — PATCH hooks subset; zero-break sibling.
- **T5** `docker/scripts/platform/apply-auth-config.ts` — render + restart CLI; `.gitignore` the
  override file; unit tests + secrets-not-in-git guard.
- **T6** README M4 section ("stored ≠ live", stack-scoped semantics, apply usage, sensitive-override
  warning, upgrade paragraph) + full verification (vitest / `tsc --noEmit -p .` / lint).
- Then: controller E2E (§11) → Fable (fallback Opus 4.8) whole-branch final review →
  finishing-a-development-branch (merge reserved to user; historically fast-forward).

## §13 Risks & accepted limitations

1. **Stored ≠ live until apply** (D1/D4) — by design; documented; E2E proves the apply path on
   `default`.
2. **Shared-stack = stack-scoped auth config** (D4) — one `supabase-auth` serves all projects on the
   stack; per-project isolation needs per-project stacks (future). `proj-b` applies to the same
   shared GoTrue.
3. **Apply override holds plaintext secrets** (§9) — mitigated by gitignore + `chmod 600` + docs +
   grep guard; unavoidable because GoTrue consumes plaintext env.
4. **`DEFAULTS` baseline may drift** from a given GoTrue release's true defaults — acceptable for an
   internal MVP; operators override via the UI; the baseline is a checked-in, testable artifact to
   correct over time.
5. **GoTrue restart drops active project sessions briefly** on apply — acceptable at internal scale;
   the platform login-gate (`supabase-platform-auth`) is a separate container, so admin access to
   Studio is unaffected.
6. **Env-name mapping edge cases** — the `GOTRUE_${field}` rule is verified for the sampled groups;
   any field GoTrue names differently silently no-ops (not a brick). `ENV_NAME_OVERRIDES` + E2E on a
   representative field set catch the tested surface; expand as needed. Logged, not silently capped.

## §14 Out of scope (other milestones)

Replication/ETL, Storage S3 credentials/settings, Realtime settings, Edge Function deploy + secrets,
network restrictions/SSL/password change (M5/M6); Logflare observability + backups (F1/F4, Phase 0/1);
per-project stack provisioning + registry stack-location metadata (D4 future); the pre-existing
main-stack `.env` demo-default rotation security debt (must be done before real launch, tracked in the
ledger, unrelated to M4).

## §15 Reuse inventory (don't rebuild)

- `secrets.ts` — `encryptSecret` / `decryptSecret`, `PLATFORM_ENCRYPTION_KEY`, fail-closed.
- `rbac/enforce.ts` — `guardProjectRoute` (`{ action, projectRef, resource?, data? }`; 404-before-403
  - MFA baked in), `checkPermission`; `matrix.ts` already covers `custom_config_gotrue` via `%`.
- `resolve-connection.ts` — `resolveProjectConnection(ref)` (ProjectNotFound → 404).
- Route skeleton — `auth/[ref]` family (`recover.ts`, users) + `enforcement.ts` (self-platform-only
  top-level 404 variant that M4 follows).
- Platform-db query helper used by `members.ts` / `organizations.ts` — parameterized platform-db access.
- `register-project.ts` — CLI structure: `docker exec -i psql` stdin params, `encryptSecret`, arg parse.
- Migration precedent — `04-roles.sql` / `05-*.sql` idempotent + README upgrade paragraph.

```

```
