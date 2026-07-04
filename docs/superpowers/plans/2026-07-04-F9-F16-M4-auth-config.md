# F9+F16 M4 — Project-level Auth Config Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the whole `/project/[ref]/auth` settings surface (~18 forms, currently 404) work by building a per-project GoTrue-config store (`GET`/`PATCH /platform/auth/{ref}/config` + `/config/hooks`) plus an operator CLI that renders the stored config into `GOTRUE_*` env and restarts GoTrue.

**Architecture:** GoTrue auth config is env-driven and read at boot — there is no runtime config API — so this is a config **store + apply**, not a proxy. Studio persists config to a new `platform.auth_config` table (jsonb hybrid: non-secret `config` + encrypted `secrets`); GET returns a curated defaults baseline overlaid with stored overrides, secrets always masked; PATCH encrypts secrets and never overwrites a masked/blank secret. An operator-run CLI (`apply-auth-config`) renders `GOTRUE_${field}` into a docker-compose override file and restarts a configurable target container (default `supabase-auth`), stack-scoped.

**Tech Stack:** Next.js pages-router API routes (TS), vitest + node-mocks-http, platform-db via `executePlatformQuery` (pg-meta `x-connection-encrypted`), crypto-js AES (`secrets.ts` `encryptSecret`/`decryptSecret`), `tsx` CLI + `docker exec`/`docker compose`.

**Spec:** `docs/self-hosted-parity/2026-07-04-F9-F16-M4-auth-config-design.md` (RATIFIED @a811bb7ce3).

## Global Constraints

Copied verbatim from spec §0/§9/§10 — every task's requirements implicitly include these:

- **Contract source:** `packages/api-types/types/platform.d.ts` is read-only, the only contract truth. Types: `GoTrueConfigResponse` (GET, 237 fields), `UpdateGoTrueConfigBody` (PATCH, 239), `UpdateGoTrueConfigHooksBody` (hooks PATCH, 21 `HOOK_*`).
- **No `as any`** except enum narrowing (`PASSWORD_REQUIRED_CHARACTERS`, `SECURITY_CAPTCHA_PROVIDER`, `SMS_PROVIDER`, `DB_MAX_POOL_SIZE_UNIT`).
- **`IS_SELF_PLATFORM` gate** at the top of every route; **pure self-hosted must be byte-identical zero-break** (sibling `*.self-hosted.test.ts`, fault-injectable).
- **Error body** top-level `{ message }`; **405** uses nested `{ data: null, error: { message } }`.
- **Zero new npm dependencies.** **404 before 403.** **fail-closed.** All SQL `$n`-parameterized.
- **Secret three-layer defense:** encrypt at rest (`encryptSecret`) + always-mask on GET (`''`) + no-overwrite on PATCH (skip masked/blank secret values) + never commit plaintext secrets to git.
- **Always-mask** (D5): GET never returns decrypted secrets (no `secrets:Read` reveal tier).
- **RBAC:** GET gate `READ` / PATCH gate `UPDATE`, both on resource `'custom_config_gotrue'`. The matrix already covers this via the `'%'` resource wildcard — **no matrix change** (view = all base roles, `write:Update` = Owner/Admin only).
- **"Stored ≠ live until `apply-auth-config` is run"**; on a shared stack, auth config + apply are stack-scoped.

**The 37-field secret set (`SECRET_FIELDS`)** — the single source of truth for masking + encryption + apply-decrypt:

```
EXTERNAL_APPLE_SECRET EXTERNAL_AZURE_SECRET EXTERNAL_BITBUCKET_SECRET EXTERNAL_DISCORD_SECRET
EXTERNAL_FACEBOOK_SECRET EXTERNAL_FIGMA_SECRET EXTERNAL_GITHUB_SECRET EXTERNAL_GITLAB_SECRET
EXTERNAL_GOOGLE_SECRET EXTERNAL_KAKAO_SECRET EXTERNAL_KEYCLOAK_SECRET EXTERNAL_LINKEDIN_OIDC_SECRET
EXTERNAL_NOTION_SECRET EXTERNAL_SLACK_OIDC_SECRET EXTERNAL_SLACK_SECRET EXTERNAL_SPOTIFY_SECRET
EXTERNAL_TWITCH_SECRET EXTERNAL_TWITTER_SECRET EXTERNAL_WORKOS_SECRET EXTERNAL_ZOOM_SECRET
EXTERNAL_X_SECRET
HOOK_AFTER_USER_CREATED_SECRETS HOOK_BEFORE_USER_CREATED_SECRETS HOOK_CUSTOM_ACCESS_TOKEN_SECRETS
HOOK_MFA_VERIFICATION_ATTEMPT_SECRETS HOOK_PASSWORD_VERIFICATION_ATTEMPT_SECRETS
HOOK_SEND_EMAIL_SECRETS HOOK_SEND_SMS_SECRETS
SMS_MESSAGEBIRD_ACCESS_KEY SMS_TEXTLOCAL_API_KEY SMS_TWILIO_AUTH_TOKEN SMS_TWILIO_VERIFY_AUTH_TOKEN
SMS_VONAGE_API_KEY SMS_VONAGE_API_SECRET
SECURITY_CAPTCHA_SECRET NIMBUS_OAUTH_CLIENT_SECRET SMTP_PASS
```

**NOT secrets** (must be excluded even though suffixes look similar): `SECURITY_UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD` (boolean), the 3 `PASSWORD_*` policy fields, and all `SMS_TWILIO_*_SID` identifiers.

---

## File Structure

- `docker/volumes/platform/migrations/06-auth-config.sql` — the `platform.auth_config` table (idempotent).
- `apps/studio/lib/api/self-platform/auth-config.ts` — data layer: `DEFAULTS`, `SECRET_FIELDS`, `readAuthConfig`, `writeAuthConfig`, `writeHookConfig`.
- `apps/studio/lib/api/self-platform/auth-config.test.ts` — data-layer unit tests.
- `apps/studio/pages/api/platform/auth/[ref]/config.ts` — GET + PATCH route.
- `apps/studio/pages/api/platform/auth/[ref]/config.test.ts` — on-mode route tests (plain filename → colocated, per `per-ref.self-hosted.test.ts` precedent; only bracket-named test files collide in Turbopack).
- `apps/studio/pages/api/platform/auth/[ref]/config.self-hosted.test.ts` — plain-mode zero-break sibling.
- `apps/studio/pages/api/platform/auth/[ref]/config/hooks.ts` — PATCH hooks-subset route.
- `apps/studio/pages/api/platform/auth/[ref]/config/hooks.test.ts` + `hooks.self-hosted.test.ts` — hooks route tests.
- `docker/scripts/platform/apply-auth-config.ts` — operator CLI (render + restart).
- `docker/scripts/platform/apply-auth-config.test.ts` — CLI pure-function unit tests.
- `.gitignore` — ignore the plaintext compose override file.
- `docker/volumes/platform/README.md` — M4 upgrade + usage + security section.

---

## Task 1: `06-auth-config.sql` migration

**Files:**

- Create: `docker/volumes/platform/migrations/06-auth-config.sql`

**Interfaces:**

- Produces: table `platform.auth_config(project_ref text PK→projects(ref), config jsonb, secrets jsonb, updated_at timestamptz, updated_by text)`.

- [ ] **Step 1: Write the migration**

```sql
-- 06-auth-config.sql
-- [self-platform] F9+F16 M4: per-project GoTrue auth config store.
-- Non-secret fields live in `config`; secret fields (provider/SMTP/hook/SMS/captcha)
-- are AES-encrypted (PLATFORM_ENCRYPTION_KEY, same scheme as platform.projects)
-- and live in `secrets`. This is a DESIRED-STATE store: GoTrue reads env at boot,
-- so changes here are not live until `apply-auth-config <ref>` is run.
-- Idempotent — safe to re-run.

create table if not exists platform.auth_config (
  project_ref text primary key
    references platform.projects (ref) on delete cascade,
  config      jsonb        not null default '{}'::jsonb,
  secrets     jsonb        not null default '{}'::jsonb,
  updated_at  timestamptz  not null default now(),
  updated_by  text
);

comment on table platform.auth_config is
  '[self-platform] M4: per-project GoTrue config store (config=non-secret, secrets=AES-encrypted). Desired state; apply via apply-auth-config.';
```

- [ ] **Step 2: Apply it live and verify idempotency**

Run:

```bash
docker exec -i supabase-platform-db psql -U postgres -d platform -v ON_ERROR_STOP=1 < docker/volumes/platform/migrations/06-auth-config.sql
docker exec -i supabase-platform-db psql -U postgres -d platform -v ON_ERROR_STOP=1 < docker/volumes/platform/migrations/06-auth-config.sql
docker exec -i supabase-platform-db psql -U postgres -d platform -c '\d platform.auth_config'
```

Expected: first apply creates the table; second apply is a no-op (`NOTICE: relation "auth_config" already exists, skipping`), exit 0 both times; `\d` shows 5 columns, PK on `project_ref`, FK to `platform.projects(ref)`.

- [ ] **Step 3: Prove the FK + cascade with a throwaway transaction**

Run:

```bash
docker exec -i supabase-platform-db psql -U postgres -d platform -v ON_ERROR_STOP=1 <<'SQL'
begin;
insert into platform.auth_config (project_ref, config) values ('default', '{"DISABLE_SIGNUP":true}'::jsonb);
select project_ref, config->>'DISABLE_SIGNUP' as disable_signup from platform.auth_config where project_ref='default';
insert into platform.auth_config (project_ref) values ('no-such-ref');  -- must FAIL (FK)
rollback;
SQL
```

Expected: the `default` insert succeeds and selects `true`; the `no-such-ref` insert raises `insert or update on table "auth_config" violates foreign key constraint`; `rollback` leaves zero residue.

- [ ] **Step 4: Commit**

```bash
git add docker/volumes/platform/migrations/06-auth-config.sql
git commit -m "feat(platform): M4 T1 — 06-auth-config.sql per-project GoTrue config store (jsonb hybrid)"
```

---

## Task 2: `auth-config.ts` data layer

**Files:**

- Create: `apps/studio/lib/api/self-platform/auth-config.ts`
- Test: `apps/studio/lib/api/self-platform/auth-config.test.ts`

**Interfaces:**

- Consumes: `executePlatformQuery<T>({ query, parameters }): Promise<{ data: T[]|undefined; error: Error|undefined }>` from `./db`; `encryptSecret(s: string): string` from `./secrets`; `components['schemas']['GoTrueConfigResponse'|'UpdateGoTrueConfigBody'|'UpdateGoTrueConfigHooksBody']` from `api-types`.
- Produces:
  - `SECRET_FIELDS: ReadonlySet<string>` (the 37 names above)
  - `DEFAULTS: GoTrueConfigResponse`
  - `readAuthConfig(projectRef: string): Promise<GoTrueConfigResponse>`
  - `writeAuthConfig(projectRef: string, body: Partial<UpdateGoTrueConfigBody>, updatedBy?: string): Promise<GoTrueConfigResponse>`
  - `writeHookConfig(projectRef: string, body: Partial<UpdateGoTrueConfigHooksBody>, updatedBy?: string): Promise<GoTrueConfigResponse>`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/studio/lib/api/self-platform/auth-config.test.ts
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULTS,
  readAuthConfig,
  SECRET_FIELDS,
  writeAuthConfig,
  writeHookConfig,
} from './auth-config'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})

const executePlatformQuery = vi.fn()
vi.mock('./db', () => ({ executePlatformQuery }))
vi.mock('./secrets', () => ({
  encryptSecret: vi.fn((s: string) => `enc:${s}`),
  decryptSecret: vi.fn(),
}))

beforeEach(() => {
  executePlatformQuery.mockReset()
})

describe('SECRET_FIELDS', () => {
  it('contains the 37 secret names and excludes lookalikes', () => {
    expect(SECRET_FIELDS.size).toBe(37)
    expect(SECRET_FIELDS.has('EXTERNAL_GITHUB_SECRET')).toBe(true)
    expect(SECRET_FIELDS.has('EXTERNAL_X_SECRET')).toBe(true)
    expect(SECRET_FIELDS.has('SMTP_PASS')).toBe(true)
    expect(SECRET_FIELDS.has('HOOK_SEND_EMAIL_SECRETS')).toBe(true)
    expect(SECRET_FIELDS.has('SMS_VONAGE_API_SECRET')).toBe(true)
    // exclusions
    expect(SECRET_FIELDS.has('SECURITY_UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD')).toBe(false)
    expect(SECRET_FIELDS.has('SMS_TWILIO_ACCOUNT_SID')).toBe(false)
    expect(SECRET_FIELDS.has('PASSWORD_MIN_LENGTH')).toBe(false)
  })
})

describe('DEFAULTS', () => {
  it('is a complete GoTrueConfigResponse with known non-zero defaults and masked-blank secrets', () => {
    expect(DEFAULTS.JWT_EXP).toBe(3600)
    expect(DEFAULTS.DISABLE_SIGNUP).toBe(false)
    // every secret field defaults blank
    for (const k of SECRET_FIELDS) {
      if (k in DEFAULTS) expect((DEFAULTS as Record<string, unknown>)[k]).toBe('')
    }
  })
})

describe('readAuthConfig', () => {
  it('overlays stored config on DEFAULTS and masks every stored/known secret', async () => {
    executePlatformQuery.mockResolvedValue({
      data: [{ config: { DISABLE_SIGNUP: true }, secrets: { EXTERNAL_GITHUB_SECRET: 'enc:xyz' } }],
      error: undefined,
    })
    const cfg = await readAuthConfig('default')
    expect(cfg.DISABLE_SIGNUP).toBe(true) // stored override wins
    expect(cfg.JWT_EXP).toBe(3600) // default preserved
    expect(cfg.EXTERNAL_GITHUB_SECRET).toBe('') // masked, never decrypted
    expect(cfg.SMTP_PASS).toBe('') // masked
    // parameterized read
    expect(executePlatformQuery.mock.calls[0][0].parameters).toEqual(['default'])
  })

  it('returns DEFAULTS (secrets masked) when no row exists', async () => {
    executePlatformQuery.mockResolvedValue({ data: [], error: undefined })
    const cfg = await readAuthConfig('ghost')
    expect(cfg.DISABLE_SIGNUP).toBe(false)
    expect(cfg.EXTERNAL_GITHUB_SECRET).toBe('')
  })

  it('throws on a query error (fail-closed)', async () => {
    executePlatformQuery.mockResolvedValue({ data: undefined, error: new Error('boom') })
    await expect(readAuthConfig('default')).rejects.toThrow('boom')
  })
})

describe('writeAuthConfig', () => {
  it('splits secret/non-secret, encrypts secrets, skips blank secrets (no-overwrite)', async () => {
    // first call = upsert, second call = re-read
    executePlatformQuery
      .mockResolvedValueOnce({ data: [], error: undefined })
      .mockResolvedValueOnce({ data: [{ config: {}, secrets: {} }], error: undefined })
    await writeAuthConfig(
      'default',
      { DISABLE_SIGNUP: true, SMTP_PASS: 'newpass', EXTERNAL_GITHUB_SECRET: '' },
      'sub-1'
    )
    const upsert = executePlatformQuery.mock.calls[0][0]
    expect(upsert.query).toContain('insert into platform.auth_config')
    expect(upsert.parameters[0]).toBe('default')
    expect(JSON.parse(upsert.parameters[1])).toEqual({ DISABLE_SIGNUP: true }) // config patch
    expect(JSON.parse(upsert.parameters[2])).toEqual({ SMTP_PASS: 'enc:newpass' }) // encrypted; blank github secret dropped
    expect(upsert.parameters[3]).toBe('sub-1')
  })

  it('writes empty patches when only a masked secret arrives', async () => {
    executePlatformQuery
      .mockResolvedValueOnce({ data: [], error: undefined })
      .mockResolvedValueOnce({ data: [{ config: {}, secrets: {} }], error: undefined })
    await writeAuthConfig('default', { SMTP_PASS: '' })
    const upsert = executePlatformQuery.mock.calls[0][0]
    expect(JSON.parse(upsert.parameters[1])).toEqual({})
    expect(JSON.parse(upsert.parameters[2])).toEqual({})
  })
})

describe('writeHookConfig', () => {
  it('stores HOOK_* fields, encrypting the *_SECRETS one', async () => {
    executePlatformQuery
      .mockResolvedValueOnce({ data: [], error: undefined })
      .mockResolvedValueOnce({ data: [{ config: {}, secrets: {} }], error: undefined })
    await writeHookConfig(
      'default',
      { HOOK_SEND_EMAIL_ENABLED: true, HOOK_SEND_EMAIL_SECRETS: 's3cr3t' },
      'sub-9'
    )
    const upsert = executePlatformQuery.mock.calls[0][0]
    expect(JSON.parse(upsert.parameters[1])).toEqual({ HOOK_SEND_EMAIL_ENABLED: true })
    expect(JSON.parse(upsert.parameters[2])).toEqual({ HOOK_SEND_EMAIL_SECRETS: 'enc:s3cr3t' })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter=studio exec vitest run lib/api/self-platform/auth-config.test.ts`
Expected: FAIL — `Cannot find module './auth-config'`.

- [ ] **Step 3: Write `auth-config.ts`**

```ts
// apps/studio/lib/api/self-platform/auth-config.ts
// [self-platform] F9+F16 M4: per-project GoTrue auth config store.
// GoTrue reads config from env at boot (no runtime API), so this is a
// desired-state store. Secrets are AES-encrypted at rest, ALWAYS masked on
// read (write-only in the UI), and never overwritten by a masked/blank value.
import type { components } from 'api-types'

import { executePlatformQuery } from './db'
import { encryptSecret } from './secrets'

type GoTrueConfigResponse = components['schemas']['GoTrueConfigResponse']
type UpdateGoTrueConfigBody = components['schemas']['UpdateGoTrueConfigBody']
type UpdateGoTrueConfigHooksBody = components['schemas']['UpdateGoTrueConfigHooksBody']

// [self-platform] Single source of truth for masking + encryption + apply-decrypt.
// 37 credential fields (36 appear in the GET response; EXTERNAL_X_SECRET is body-only).
// Deliberately EXCLUDES boolean/identifier lookalikes (…REQUIRE_CURRENT_PASSWORD,
// PASSWORD_*, SMS_TWILIO_*_SID).
export const SECRET_FIELDS: ReadonlySet<string> = new Set([
  'EXTERNAL_APPLE_SECRET',
  'EXTERNAL_AZURE_SECRET',
  'EXTERNAL_BITBUCKET_SECRET',
  'EXTERNAL_DISCORD_SECRET',
  'EXTERNAL_FACEBOOK_SECRET',
  'EXTERNAL_FIGMA_SECRET',
  'EXTERNAL_GITHUB_SECRET',
  'EXTERNAL_GITLAB_SECRET',
  'EXTERNAL_GOOGLE_SECRET',
  'EXTERNAL_KAKAO_SECRET',
  'EXTERNAL_KEYCLOAK_SECRET',
  'EXTERNAL_LINKEDIN_OIDC_SECRET',
  'EXTERNAL_NOTION_SECRET',
  'EXTERNAL_SLACK_OIDC_SECRET',
  'EXTERNAL_SLACK_SECRET',
  'EXTERNAL_SPOTIFY_SECRET',
  'EXTERNAL_TWITCH_SECRET',
  'EXTERNAL_TWITTER_SECRET',
  'EXTERNAL_WORKOS_SECRET',
  'EXTERNAL_ZOOM_SECRET',
  'EXTERNAL_X_SECRET',
  'HOOK_AFTER_USER_CREATED_SECRETS',
  'HOOK_BEFORE_USER_CREATED_SECRETS',
  'HOOK_CUSTOM_ACCESS_TOKEN_SECRETS',
  'HOOK_MFA_VERIFICATION_ATTEMPT_SECRETS',
  'HOOK_PASSWORD_VERIFICATION_ATTEMPT_SECRETS',
  'HOOK_SEND_EMAIL_SECRETS',
  'HOOK_SEND_SMS_SECRETS',
  'SMS_MESSAGEBIRD_ACCESS_KEY',
  'SMS_TEXTLOCAL_API_KEY',
  'SMS_TWILIO_AUTH_TOKEN',
  'SMS_TWILIO_VERIFY_AUTH_TOKEN',
  'SMS_VONAGE_API_KEY',
  'SMS_VONAGE_API_SECRET',
  'SECURITY_CAPTCHA_SECRET',
  'NIMBUS_OAUTH_CLIENT_SECRET',
  'SMTP_PASS',
])

// [self-platform] Curated defaults baseline. TypeScript (`: GoTrueConfigResponse`)
// forces every one of the 237 contract fields to be present — a missing field is a
// tsc error, so this object is provably complete. RULE: each field is its type-zero
// (boolean → false, string → '', number → 0, nested objects → all-false, the enum
// DB_MAX_POOL_SIZE_UNIT → null) EXCEPT the small set of GoTrue documented non-zero
// defaults set explicitly below. This is a desired-state baseline, NOT a live-GoTrue
// mirror (spec §13 risk 4) — operators override via the UI; unset ⇒ type-zero.
export const DEFAULTS: GoTrueConfigResponse = {
  // ---- known non-zero GoTrue documented defaults (set explicitly) ----
  JWT_EXP: 3600,
  PASSWORD_MIN_LENGTH: 6,
  MFA_MAX_ENROLLED_FACTORS: 10,
  MAILER_OTP_LENGTH: 6,
  SMS_OTP_LENGTH: 6,
  DB_MAX_POOL_SIZE_UNIT: null,
  // ---- all remaining 231 fields: type-zero ----
  // The implementer fills every other GoTrueConfigResponse key at its type-zero:
  //   boolean → false, string → '', number → 0,
  //   MAILER_SUBJECTS_CUSTOM_CONTENTS → { <13 keys>: false },
  //   MAILER_TEMPLATES_CUSTOM_CONTENTS → { <13 keys>: false },
  //   CUSTOM_OAUTH_MAX_PROVIDERS → 0.
  // tsc will list any field you miss; add it at type-zero. Do NOT guess non-zero
  // values — type-zero for anything not in the explicit block above.
} as GoTrueConfigResponse
// NOTE: the `as GoTrueConfigResponse` above is a TEMPORARY scaffold marker only —
// once every field is filled, DELETE the `as` cast so tsc enforces completeness for
// real. Leaving the cast in is a plan violation (it would hide missing fields).

const EMPTY_ROW = { config: {}, secrets: {} }

type StoredRow = { config: Record<string, unknown>; secrets: Record<string, string> }

async function loadRow(projectRef: string): Promise<StoredRow> {
  const { data, error } = await executePlatformQuery<StoredRow>({
    query: 'select config, secrets from platform.auth_config where project_ref = $1',
    parameters: [projectRef],
  })
  if (error) throw error
  return data?.[0] ?? EMPTY_ROW
}

export async function readAuthConfig(projectRef: string): Promise<GoTrueConfigResponse> {
  const row = await loadRow(projectRef)
  const merged: Record<string, unknown> = {
    ...(DEFAULTS as Record<string, unknown>),
    ...row.config,
  }
  // Always-mask: never decrypt for the API. Mask only keys already present so the
  // body-only EXTERNAL_X_SECRET is not added as an off-contract extra field.
  for (const key of SECRET_FIELDS) {
    if (key in merged) merged[key] = ''
  }
  return merged as GoTrueConfigResponse
}

// [self-platform] Shared write path for both the full config PATCH and the hooks
// PATCH. Partitions incoming keys into secret vs non-secret, encrypts secrets,
// drops masked/blank secrets (no-overwrite), and upserts via jsonb `||` merge.
async function upsertConfig(
  projectRef: string,
  body: Record<string, unknown>,
  updatedBy?: string
): Promise<GoTrueConfigResponse> {
  const configPatch: Record<string, unknown> = {}
  const secretPatch: Record<string, string> = {}
  for (const [key, value] of Object.entries(body)) {
    if (SECRET_FIELDS.has(key)) {
      if (value === '' || value === null || value === undefined) continue // no-overwrite
      secretPatch[key] = encryptSecret(String(value))
    } else {
      configPatch[key] = value
    }
  }
  const { error } = await executePlatformQuery({
    query: `
      insert into platform.auth_config (project_ref, config, secrets, updated_by)
      values ($1, $2::jsonb, $3::jsonb, $4)
      on conflict (project_ref) do update set
        config = platform.auth_config.config || excluded.config,
        secrets = platform.auth_config.secrets || excluded.secrets,
        updated_at = now(),
        updated_by = excluded.updated_by
    `,
    parameters: [
      projectRef,
      JSON.stringify(configPatch),
      JSON.stringify(secretPatch),
      updatedBy ?? null,
    ],
  })
  if (error) throw error
  return readAuthConfig(projectRef)
}

export function writeAuthConfig(
  projectRef: string,
  body: Partial<UpdateGoTrueConfigBody>,
  updatedBy?: string
): Promise<GoTrueConfigResponse> {
  return upsertConfig(projectRef, body as Record<string, unknown>, updatedBy)
}

export function writeHookConfig(
  projectRef: string,
  body: Partial<UpdateGoTrueConfigHooksBody>,
  updatedBy?: string
): Promise<GoTrueConfigResponse> {
  return upsertConfig(projectRef, body as Record<string, unknown>, updatedBy)
}
```

- [ ] **Step 4: Fill every remaining `DEFAULTS` field at type-zero, then remove the `as` cast**

Change `export const DEFAULTS: GoTrueConfigResponse = { … } as GoTrueConfigResponse` to `export const DEFAULTS: GoTrueConfigResponse = { … }` (no cast), then run `pnpm --filter=studio exec tsc --noEmit -p .` repeatedly, adding each field tsc reports as missing at its type-zero (booleans `false`, strings `''`, numbers `0`; the two `*_CUSTOM_CONTENTS` objects with their 13 boolean sub-keys all `false`; `CUSTOM_OAUTH_MAX_PROVIDERS: 0`) until tsc reports 0 errors for this file.
Expected: tsc exits 0 with the cast removed — proving all 237 fields are present.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter=studio exec vitest run lib/api/self-platform/auth-config.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 6: Commit**

```bash
git add apps/studio/lib/api/self-platform/auth-config.ts apps/studio/lib/api/self-platform/auth-config.test.ts
git commit -m "feat(platform): M4 T2 — auth-config.ts data layer (defaults, mask, encrypt, no-overwrite)"
```

---

## Task 3: `config.ts` route (GET + PATCH)

**Files:**

- Create: `apps/studio/pages/api/platform/auth/[ref]/config.ts`
- Test: `apps/studio/pages/api/platform/auth/[ref]/config.test.ts`
- Test: `apps/studio/pages/api/platform/auth/[ref]/config.self-hosted.test.ts`

**Interfaces:**

- Consumes: `readAuthConfig`, `writeAuthConfig` (Task 2); `guardProjectRoute(res, claims, { action, projectRef, resource?, data? }): Promise<boolean>` from `@/lib/api/self-platform/rbac/enforce`; `IS_SELF_PLATFORM` from `@/lib/constants/self-platform`; `PermissionAction` from `@supabase/shared-types/out/constants` (`READ` = `'read:Read'`, `UPDATE` = `'write:Update'`).
- Produces: `handler(req, res, claims?)` (exported for tests); default `apiWrapper`-wrapped export.

- [ ] **Step 1: Write the failing on-mode tests**

```ts
// apps/studio/pages/api/platform/auth/[ref]/config.test.ts
import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './config'
import { readAuthConfig, writeAuthConfig } from '@/lib/api/self-platform/auth-config'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})

vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardProjectRoute: vi.fn() }))
vi.mock('@/lib/api/self-platform/auth-config', () => ({
  readAuthConfig: vi.fn(),
  writeAuthConfig: vi.fn(),
}))

const claimsOf = (sub: string) => ({ sub }) as JwtPayload

beforeEach(() => {
  vi.mocked(guardProjectRoute).mockReset().mockResolvedValue(true)
  vi.mocked(readAuthConfig)
    .mockReset()
    .mockResolvedValue({ DISABLE_SIGNUP: false } as never)
  vi.mocked(writeAuthConfig)
    .mockReset()
    .mockResolvedValue({ DISABLE_SIGNUP: true } as never)
})

describe('GET/PATCH /platform/auth/[ref]/config (self-platform)', () => {
  it('GET is read-gated on custom_config_gotrue and returns the config', async () => {
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })
    await handler(req as never, res as never, claimsOf('g-1'))
    expect(vi.mocked(guardProjectRoute).mock.calls[0][2]).toMatchObject({
      action: 'read:Read',
      projectRef: 'default',
      resource: 'custom_config_gotrue',
    })
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toEqual({ DISABLE_SIGNUP: false })
    expect(readAuthConfig).toHaveBeenCalledWith('default')
  })

  it('GET denied → guard short-circuits, data layer untouched', async () => {
    vi.mocked(guardProjectRoute).mockResolvedValue(false)
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })
    await handler(req as never, res as never, claimsOf('g-dev'))
    expect(readAuthConfig).not.toHaveBeenCalled()
  })

  it('PATCH is write-gated (UPDATE) and threads body + updated_by', async () => {
    const { req, res } = createMocks({
      method: 'PATCH',
      query: { ref: 'default' },
      body: { DISABLE_SIGNUP: true },
    })
    await handler(req as never, res as never, claimsOf('g-owner'))
    expect(vi.mocked(guardProjectRoute).mock.calls[0][2]).toMatchObject({
      action: 'write:Update',
      resource: 'custom_config_gotrue',
    })
    expect(writeAuthConfig).toHaveBeenCalledWith('default', { DISABLE_SIGNUP: true }, 'g-owner')
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toEqual({ DISABLE_SIGNUP: true })
  })

  it('405 for unsupported method; 400 for array ref', async () => {
    const put = createMocks({ method: 'PUT', query: { ref: 'default' } })
    await handler(put.req as never, put.res as never, claimsOf('g-1'))
    expect(put.res._getStatusCode()).toBe(405)
    const arr = createMocks({ method: 'GET', query: { ref: ['a', 'b'] } })
    await handler(arr.req as never, arr.res as never, claimsOf('g-1'))
    expect(arr.res._getStatusCode()).toBe(400)
    expect(guardProjectRoute).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Write the failing zero-break sibling test**

```ts
// apps/studio/pages/api/platform/auth/[ref]/config.self-hosted.test.ts
import { createMocks } from 'node-mocks-http'
import { describe, expect, it, vi } from 'vitest'

import { handler } from './config'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = ''
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
})

describe('config zero-break (plain self-hosted)', () => {
  it.each(['GET', 'PATCH', 'PUT'])('%s → byte-identical 404', async (method) => {
    const { req, res } = createMocks({ method: method as never, query: { ref: 'default' } })
    await handler(req as never, res as never, undefined)
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ message: 'Not available on this deployment' })
  })
})
```

- [ ] **Step 3: Run both to verify they fail**

Run: `pnpm --filter=studio exec vitest run 'auth/[ref]/config.test.ts' 'auth/[ref]/config.self-hosted.test.ts'`
Expected: FAIL — `Cannot find module './config'`.

- [ ] **Step 4: Write `config.ts`**

```ts
// apps/studio/pages/api/platform/auth/[ref]/config.ts
// [self-platform] F9+F16 M4: per-project GoTrue config GET/PATCH. Self-platform
// only (no plain-mode target) — top-level 404 like the MFA-enforcement route,
// NOT the recover.ts per-ref proxy pattern. Secrets are always masked on GET.
import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import type { components } from 'api-types'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { readAuthConfig, writeAuthConfig } from '@/lib/api/self-platform/auth-config'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

type UpdateGoTrueConfigBody = components['schemas']['UpdateGoTrueConfigBody']

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: true })

// [self-platform] exported for handler-level tests
export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  if (!IS_SELF_PLATFORM) {
    return res.status(404).json({ message: 'Not available on this deployment' })
  }
  if (req.method !== 'GET' && req.method !== 'PATCH') {
    res.setHeader('Allow', ['GET', 'PATCH'])
    return res
      .status(405)
      .json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }
  if (Array.isArray(req.query.ref)) {
    return res.status(400).json({ message: 'Invalid ref parameter' })
  }
  const ref = String(req.query.ref)

  if (req.method === 'GET') {
    const ok = await guardProjectRoute(res, claims, {
      action: PermissionAction.READ,
      projectRef: ref,
      resource: 'custom_config_gotrue',
    })
    if (!ok) return
    return res.status(200).json(await readAuthConfig(ref))
  }

  const body = (req.body ?? {}) as Partial<UpdateGoTrueConfigBody>
  const ok = await guardProjectRoute(res, claims, {
    action: PermissionAction.UPDATE,
    projectRef: ref,
    resource: 'custom_config_gotrue',
  })
  if (!ok) return
  return res.status(200).json(await writeAuthConfig(ref, body, claims?.sub))
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter=studio exec vitest run 'auth/[ref]/config.test.ts' 'auth/[ref]/config.self-hosted.test.ts'`
Expected: PASS (both suites).

- [ ] **Step 6: Prove the sibling actually discriminates (fault-injection)**

Temporarily change the top guard to `if (false)`, re-run `config.self-hosted.test.ts`, confirm it FAILS (405/200 instead of 404), then revert.
Expected: RED under fault injection, GREEN after revert.

- [ ] **Step 7: Commit**

```bash
git add apps/studio/pages/api/platform/auth/[ref]/config.ts apps/studio/pages/api/platform/auth/[ref]/config.test.ts apps/studio/pages/api/platform/auth/[ref]/config.self-hosted.test.ts
git commit -m "feat(platform): M4 T3 — config.ts GET/PATCH (custom_config_gotrue gate, always-mask, zero-break)"
```

---

## Task 4: `config/hooks.ts` route (PATCH)

**Files:**

- Create: `apps/studio/pages/api/platform/auth/[ref]/config/hooks.ts`
- Test: `apps/studio/pages/api/platform/auth/[ref]/config/hooks.test.ts`
- Test: `apps/studio/pages/api/platform/auth/[ref]/config/hooks.self-hosted.test.ts`

**Interfaces:**

- Consumes: `writeHookConfig` (Task 2); `guardProjectRoute` (UPDATE `custom_config_gotrue`); `IS_SELF_PLATFORM`.
- Produces: `handler(req, res, claims?)`.

- [ ] **Step 1: Write the failing on-mode test**

```ts
// apps/studio/pages/api/platform/auth/[ref]/config/hooks.test.ts
import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './hooks'
import { writeHookConfig } from '@/lib/api/self-platform/auth-config'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})

vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardProjectRoute: vi.fn() }))
vi.mock('@/lib/api/self-platform/auth-config', () => ({ writeHookConfig: vi.fn() }))

const claimsOf = (sub: string) => ({ sub }) as JwtPayload

beforeEach(() => {
  vi.mocked(guardProjectRoute).mockReset().mockResolvedValue(true)
  vi.mocked(writeHookConfig)
    .mockReset()
    .mockResolvedValue({ DISABLE_SIGNUP: false } as never)
})

describe('PATCH /platform/auth/[ref]/config/hooks (self-platform)', () => {
  it('is write-gated (UPDATE custom_config_gotrue) and persists the hook body', async () => {
    const { req, res } = createMocks({
      method: 'PATCH',
      query: { ref: 'default' },
      body: { HOOK_SEND_EMAIL_ENABLED: true },
    })
    await handler(req as never, res as never, claimsOf('g-owner'))
    expect(vi.mocked(guardProjectRoute).mock.calls[0][2]).toMatchObject({
      action: 'write:Update',
      resource: 'custom_config_gotrue',
    })
    expect(writeHookConfig).toHaveBeenCalledWith(
      'default',
      { HOOK_SEND_EMAIL_ENABLED: true },
      'g-owner'
    )
    expect(res._getStatusCode()).toBe(200)
  })

  it('405 for GET (hooks is PATCH-only)', async () => {
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'default' } })
    await handler(req as never, res as never, claimsOf('g-1'))
    expect(res._getStatusCode()).toBe(405)
    expect(guardProjectRoute).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Write the failing zero-break sibling test**

```ts
// apps/studio/pages/api/platform/auth/[ref]/config/hooks.self-hosted.test.ts
import { createMocks } from 'node-mocks-http'
import { describe, expect, it, vi } from 'vitest'

import { handler } from './hooks'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = ''
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
})

describe('config/hooks zero-break (plain self-hosted)', () => {
  it.each(['PATCH', 'GET'])('%s → byte-identical 404', async (method) => {
    const { req, res } = createMocks({ method: method as never, query: { ref: 'default' } })
    await handler(req as never, res as never, undefined)
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ message: 'Not available on this deployment' })
  })
})
```

- [ ] **Step 3: Run to verify they fail**

Run: `pnpm --filter=studio exec vitest run 'auth/[ref]/config/hooks.test.ts' 'auth/[ref]/config/hooks.self-hosted.test.ts'`
Expected: FAIL — `Cannot find module './hooks'`.

- [ ] **Step 4: Write `config/hooks.ts`**

```ts
// apps/studio/pages/api/platform/auth/[ref]/config/hooks.ts
// [self-platform] F9+F16 M4: GoTrue auth hooks PATCH (HOOK_* subset of the config
// store). PATCH-only; same UPDATE custom_config_gotrue gate as config.ts.
import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import type { components } from 'api-types'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { writeHookConfig } from '@/lib/api/self-platform/auth-config'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

type UpdateGoTrueConfigHooksBody = components['schemas']['UpdateGoTrueConfigHooksBody']

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: true })

export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  if (!IS_SELF_PLATFORM) {
    return res.status(404).json({ message: 'Not available on this deployment' })
  }
  if (req.method !== 'PATCH') {
    res.setHeader('Allow', ['PATCH'])
    return res
      .status(405)
      .json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }
  if (Array.isArray(req.query.ref)) {
    return res.status(400).json({ message: 'Invalid ref parameter' })
  }
  const ref = String(req.query.ref)
  const body = (req.body ?? {}) as Partial<UpdateGoTrueConfigHooksBody>
  const ok = await guardProjectRoute(res, claims, {
    action: PermissionAction.UPDATE,
    projectRef: ref,
    resource: 'custom_config_gotrue',
  })
  if (!ok) return
  return res.status(200).json(await writeHookConfig(ref, body, claims?.sub))
}
```

- [ ] **Step 5: Run to verify pass**

Run: `pnpm --filter=studio exec vitest run 'auth/[ref]/config/hooks.test.ts' 'auth/[ref]/config/hooks.self-hosted.test.ts'`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/studio/pages/api/platform/auth/[ref]/config/hooks.ts apps/studio/pages/api/platform/auth/[ref]/config/hooks.test.ts apps/studio/pages/api/platform/auth/[ref]/config/hooks.self-hosted.test.ts
git commit -m "feat(platform): M4 T4 — config/hooks.ts PATCH (HOOK_* subset, same gate, zero-break)"
```

---

## Task 5: `apply-auth-config` CLI

**Files:**

- Create: `docker/scripts/platform/apply-auth-config.ts`
- Test: `docker/scripts/platform/apply-auth-config.test.ts`
- Modify: `.gitignore` (ignore the plaintext override file)

**Interfaces:**

- Consumes: `crypto-js` (inline `decryptSecret`, mirrors `register-project.ts`'s inline `encryptSecret`); `execFileSync` for `docker exec`/`docker compose`.
- Produces (exported for tests): `parseArgs(argv): { ref?: string; target?: string; dryRun: boolean }`; `renderGotrueEnv(effective: Record<string, unknown>): Record<string, string>`; `toComposeOverrideYaml(service: string, env: Record<string, string>): string`; `main(argv?)`.

- [ ] **Step 1: Write the failing pure-function tests**

```ts
// docker/scripts/platform/apply-auth-config.test.ts
import { describe, expect, it } from 'vitest'

import { parseArgs, renderGotrueEnv, toComposeOverrideYaml } from './apply-auth-config'

describe('parseArgs', () => {
  it('reads the ref, --target, and --dry-run', () => {
    expect(parseArgs(['default'])).toEqual({ ref: 'default', target: undefined, dryRun: false })
    expect(parseArgs(['proj-b', '--target', 'proj-b-auth', '--dry-run'])).toEqual({
      ref: 'proj-b',
      target: 'proj-b-auth',
      dryRun: true,
    })
  })
})

describe('renderGotrueEnv', () => {
  it('maps fields to GOTRUE_<field>, formats scalars, skips null and read-only fields', () => {
    const env = renderGotrueEnv({
      DISABLE_SIGNUP: true,
      JWT_EXP: 3600,
      SITE_URL: 'http://localhost:8082',
      URI_ALLOW_LIST: ['http://a', 'http://b'],
      SMTP_PASS: 'plaintext-decrypted',
      MAILER_AUTOCONFIRM: null,
      CUSTOM_OAUTH_MAX_PROVIDERS: 50, // read-only → never rendered
    })
    expect(env).toEqual({
      GOTRUE_DISABLE_SIGNUP: 'true',
      GOTRUE_JWT_EXP: '3600',
      GOTRUE_SITE_URL: 'http://localhost:8082',
      GOTRUE_URI_ALLOW_LIST: 'http://a,http://b',
      GOTRUE_SMTP_PASS: 'plaintext-decrypted',
    })
  })
})

describe('toComposeOverrideYaml', () => {
  it('emits a services.<svc>.environment block with quoted values', () => {
    const yaml = toComposeOverrideYaml('supabase-auth', {
      GOTRUE_DISABLE_SIGNUP: 'true',
      GOTRUE_SITE_URL: 'http://localhost:8082',
    })
    expect(yaml).toContain('services:')
    expect(yaml).toContain('  supabase-auth:')
    expect(yaml).toContain('    environment:')
    expect(yaml).toContain('      GOTRUE_DISABLE_SIGNUP: "true"')
    expect(yaml).toContain('      GOTRUE_SITE_URL: "http://localhost:8082"')
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter=studio exec vitest --root ../.. run docker/scripts/platform/apply-auth-config.test.ts` (docker/ is outside the studio root, so `--root ../..` is required — M2 register-project.test.ts precedent)
Expected: FAIL — module not found.

- [ ] **Step 3: Write `apply-auth-config.ts`**

```ts
#!/usr/bin/env tsx
// [self-platform] F9+F16 M4: render a project's stored GoTrue config into a
// docker-compose override and restart the target GoTrue container.
//
// GoTrue reads env at boot, so this is how stored config becomes LIVE. On a
// shared stack the target GoTrue serves every project → applying any ref is
// stack-scoped. Studio never runs this; an operator does (like register-project).
//
// SECURITY: the rendered override file contains DECRYPTED secrets (GOTRUE_*_SECRET,
// GOTRUE_SMTP_PASS). It is gitignored + must be chmod 600. Never commit it.
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import crypto from 'crypto-js'

// Field names GoTrue reads under a different env name than GOTRUE_<field>.
// Empty today (the contract field names ARE the GoTrue env names sans prefix);
// add an entry only if a live field is proven to disagree.
const ENV_NAME_OVERRIDES: Record<string, string> = {}

// Response-only / computed fields that must never be applied.
const READONLY_FIELDS = new Set([
  'MAILER_SUBJECTS_CUSTOM_CONTENTS',
  'MAILER_TEMPLATES_CUSTOM_CONTENTS',
  'CUSTOM_OAUTH_MAX_PROVIDERS',
])

function decryptSecret(
  ciphertext: string,
  key = process.env.PLATFORM_ENCRYPTION_KEY || ''
): string {
  if (!key) throw new Error('PLATFORM_ENCRYPTION_KEY is not set')
  const out = crypto.AES.decrypt(ciphertext, key).toString(crypto.enc.Utf8)
  if (!out) throw new Error('failed to decrypt platform secret')
  return out
}

export function parseArgs(argv: string[]): { ref?: string; target?: string; dryRun: boolean } {
  let ref: string | undefined
  let target: string | undefined
  let dryRun = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') dryRun = true
    else if (a === '--target') target = argv[++i]
    else if (!a.startsWith('--') && ref === undefined) ref = a
  }
  return { ref, target, dryRun }
}

function formatValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.join(',')
  return String(value)
}

// effective = { ...stored.config, ...decrypted secrets } — real overrides only.
export function renderGotrueEnv(effective: Record<string, unknown>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [field, value] of Object.entries(effective)) {
    if (READONLY_FIELDS.has(field)) continue
    const formatted = formatValue(value)
    if (formatted === undefined) continue
    env[ENV_NAME_OVERRIDES[field] ?? `GOTRUE_${field}`] = formatted
  }
  return env
}

export function toComposeOverrideYaml(service: string, env: Record<string, string>): string {
  const lines = [
    '# [self-platform] M4 GENERATED by apply-auth-config — DO NOT COMMIT (contains plaintext secrets).',
    'services:',
    `  ${service}:`,
    '    environment:',
  ]
  for (const [k, v] of Object.entries(env)) {
    lines.push(`      ${k}: ${JSON.stringify(v)}`)
  }
  return lines.join('\n') + '\n'
}

// Reads config+secrets for a ref from platform-db via `docker exec psql`
// (register-project.ts pattern: PREPARE/EXECUTE with escaped literals over stdin).
function loadStored(ref: string): {
  config: Record<string, unknown>
  secrets: Record<string, string>
} {
  const container = process.env.PLATFORM_DB_CONTAINER || 'supabase-platform-db'
  const literal = `'${ref.replace(/'/g, "''")}'`
  const sql = `select coalesce(json_build_object('config', config, 'secrets', secrets)::text, '') from platform.auth_config where project_ref = ${literal};`
  const out = execFileSync(
    'docker',
    [
      'exec',
      '-i',
      container,
      'psql',
      '-U',
      'postgres',
      '-d',
      'platform',
      '-t',
      '-A',
      '-v',
      'ON_ERROR_STOP=1',
    ],
    { input: sql + '\n', encoding: 'utf8' }
  ).trim()
  if (!out) return { config: {}, secrets: {} }
  return JSON.parse(out)
}

export function main(argv = process.argv.slice(2)) {
  const { ref, target, dryRun } = parseArgs(argv)
  if (!ref) throw new Error('usage: apply-auth-config <ref> [--target <container>] [--dry-run]')
  const service = target || process.env.PLATFORM_AUTH_CONTAINER || 'supabase-auth'

  const stored = loadStored(ref)
  const decrypted: Record<string, string> = {}
  for (const [k, v] of Object.entries(stored.secrets)) decrypted[k] = decryptSecret(v)
  const env = renderGotrueEnv({ ...stored.config, ...decrypted })

  const yaml = toComposeOverrideYaml(service, env)
  if (dryRun) {
    process.stdout.write(yaml)
    process.stdout.write(
      `\n# dry-run: would restart ${service} with ${Object.keys(env).length} GOTRUE_* vars\n`
    )
    return
  }

  const composeDir =
    process.env.PLATFORM_COMPOSE_DIR || path.resolve(__dirname, '../../..', 'docker')
  const overridePath = path.join(composeDir, 'docker-compose.auth-override.yml')
  writeFileSync(overridePath, yaml, { mode: 0o600 })
  process.stderr.write(
    `[apply-auth-config] wrote ${overridePath} (contains PLAINTEXT secrets — chmod 600, never commit)\n`
  )
  execFileSync(
    'docker',
    [
      'compose',
      '-f',
      'docker-compose.yml',
      '-f',
      'docker-compose.auth-override.yml',
      'up',
      '-d',
      service,
    ],
    { cwd: composeDir, stdio: 'inherit' }
  )
  process.stdout.write(`[apply-auth-config] applied ${ref} → restarted ${service} (stack-scoped)\n`)
}

// tsx entrypoint
if (process.argv[1] && process.argv[1].endsWith('apply-auth-config.ts')) {
  main()
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter=studio exec vitest --root ../.. run docker/scripts/platform/apply-auth-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Ignore the plaintext override file**

Add to `.gitignore` (anywhere in the docker section, e.g. after the `!docker/.env` exemptions near line 132):

```
# [self-platform] M4: apply-auth-config renders plaintext GoTrue secrets here — never commit
docker/docker-compose.auth-override.yml
docker/*.auth-override.yml
```

- [ ] **Step 6: Verify the override path is untrackable + dry-run works**

Run:

```bash
git check-ignore docker/docker-compose.auth-override.yml && echo IGNORED
npx tsx docker/scripts/platform/apply-auth-config.ts default --dry-run
```

Expected: prints `IGNORED`; the dry-run prints a `services: / supabase-auth: / environment:` YAML block (may be empty of vars if `default` has no stored row yet) and a `# dry-run: would restart supabase-auth …` line; no file written, no container restarted.

- [ ] **Step 7: Commit**

```bash
git add docker/scripts/platform/apply-auth-config.ts docker/scripts/platform/apply-auth-config.test.ts .gitignore
git commit -m "feat(platform): M4 T5 — apply-auth-config CLI (GOTRUE_* render + compose override + restart)"
```

---

## Task 6: README + full verification

**Files:**

- Modify: `docker/volumes/platform/README.md`

**Interfaces:** none (docs + verification).

- [ ] **Step 1: Add the M4 README section**

Append an M4 section to `docker/volumes/platform/README.md` (match the heading level + fenced-bash style of the existing 04/05 sections). It MUST cover, in prose an operator can follow:

- **What it is:** the `/project/[ref]/auth` config panel is now served by `GET/PATCH /platform/auth/{ref}/config` (+ `/config/hooks`), backed by `platform.auth_config`.
- **Upgrade an existing platform-db:**
  ```bash
  docker exec -i supabase-platform-db psql -U postgres -d platform -v ON_ERROR_STOP=1 \
    < docker/volumes/platform/migrations/06-auth-config.sql
  ```
- **Stored ≠ live:** editing config in Studio only persists it. To make it live, an operator runs:
  ```bash
  npx tsx docker/scripts/platform/apply-auth-config.ts <ref> [--target <container>] [--dry-run]
  ```
  which renders `GOTRUE_*` into `docker/docker-compose.auth-override.yml` and restarts the target GoTrue (default `supabase-auth`, overridable via `--target`/`PLATFORM_AUTH_CONTAINER`).
- **⚠ Security (call out loudly):** the generated `docker-compose.auth-override.yml` contains **decrypted** provider/SMTP/hook secrets. It is gitignored and written `chmod 600` — never commit it, never share it. At-rest secrets in `platform.auth_config.secrets` are AES-encrypted (`PLATFORM_ENCRYPTION_KEY`); GET always masks them; PATCH never overwrites a stored secret with a blank/masked value.
- **Shared-stack semantics:** one `supabase-auth` serves every project on the stack, so applying any ref's config restarts that shared GoTrue and takes effect stack-wide. True per-project isolation needs per-project stacks (future work).
- **RBAC:** any project member can view auth config; only Owner/Admin can change it (`custom_config_gotrue`).

- [ ] **Step 2: Full verification**

Run:

```bash
pnpm --filter=studio exec vitest run lib/api/self-platform/auth-config.test.ts 'auth/[ref]/config'
pnpm --filter=studio exec tsc --noEmit -p .
pnpm lint --filter=studio
```

Expected: all M4 unit suites pass; `tsc` exits 0 (clearing any stale `.next/types` noise per house convention — direct `tsc --noEmit -p .` is the gate); lint 0 errors (declare any new env var in `turbo.jsonc` if lint flags one — `PLATFORM_AUTH_CONTAINER`, `PLATFORM_COMPOSE_DIR`, `PLATFORM_DB_CONTAINER` are CLI-only/Node-side and should not trip the Studio lint, but declare if needed).

- [ ] **Step 3: Run the whole Studio suite for regressions**

Run: `pnpm test:studio`
Expected: baseline 4825 + M4 additions all pass; no pre-existing suite regressed (the known `secrets.test.ts` AES-garbage flake and `SupportFormPage` external-network flake pass on rerun in isolation if they blip).

- [ ] **Step 4: Commit**

```bash
git add docker/volumes/platform/README.md
git commit -m "docs(platform): M4 T6 — README auth-config section (store/apply, security, stack-scoped) + full verification"
```

---

## Post-implementation (controller-driven, not a subagent task)

1. **Controller E2E** (spec §11) — live `:8082` self-platform + `supabase-auth` via Kong `:8100` + `platform-db`: open an Auth page (no 404); PATCH a non-secret + a secret → psql-verify ciphertext in `secrets`, non-secret in `config`, `updated_by` set; re-GET masks the secret; save again without touching it → ciphertext preserved (no-overwrite live); Developer/Read-only PATCH → 403, Developer GET → 200; `apply-auth-config default` → `supabase-auth` restarts → the change is live; unknown ref → 404; `enforce_mfa` on + aal1 → 403; plain-mode (both flags off) → 404 byte-identical; restore flags.
2. **Final whole-branch review** — Fable (fallback Opus 4.8), range `custom/main @8a666d4ee5..HEAD`.
3. **finishing-a-development-branch** — merge decision reserved to the user (historically fast-forward).

---

## Self-Review

**1. Spec coverage:** §2 contract → T2 (`SECRET_FIELDS`, `DEFAULTS`, types). §4 table → T1. §5 data layer → T2. §6 routes → T3/T4. §7 RBAC (no matrix change) → T3/T4 gate + tests assert action/resource. §8 apply CLI → T5. §9 security (encrypt/mask/no-overwrite + plaintext-override gitignore) → T2 + T5 + T6. §11 testing → each task's tests + post-impl E2E. §12 task split → T1–T6. No spec section is unmapped.
**2. Placeholder scan:** The only intentional "fill in" is `DEFAULTS`' 231 type-zero fields — handled as a _deterministic rule_ (type-zero, cast removed, tsc-enforced completeness in T2 Step 4), not a vague TODO. No other placeholders.
**3. Type consistency:** `readAuthConfig`/`writeAuthConfig`/`writeHookConfig` signatures identical across T2 (definition) and T3/T4 (consumption + mock return types). `guardProjectRoute(res, claims, { action, projectRef, resource })` matches enforce.ts. `executePlatformQuery({ query, parameters })` matches db.ts. `PermissionAction.READ`='read:Read' / `.UPDATE`='write:Update' match enforcement.test.ts. `renderGotrueEnv`/`toComposeOverrideYaml`/`parseArgs` names consistent between T5 code and tests.
