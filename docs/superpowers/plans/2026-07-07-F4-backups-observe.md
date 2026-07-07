# F4 (Tier 2 物理/PITR 观测优先) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let self-hosted (management-plane) Studio OBSERVE an operator-deployed pgBackRest physical-backup / PITR state on the Database → Backups page, with honest degradation and no restore/trigger/provision.

**Architecture:** An operator's backup cron writes `pgbackrest info --output=json` into a singleton status table in the project DB (`_supabase_platform.pgbackrest_info`). A new self-platform lib (`backups.ts`) reads that table through the existing pg-meta encrypted-DSN channel (via `resolveProjectConnection`) and maps it to the upstream `BackupsResponse` contract. The existing stub route `GET /platform/database/{ref}/backups` is upgraded to call that lib under `IS_SELF_PLATFORM` (RBAC READ guard, honest-empty on any failure). The existing Backups frontend already consumes `BackupsResponse`, so the list + PITR window light up automatically; restore/trigger surfaces are disabled and the restore-to-new-project tab hidden under `IS_SELF_PLATFORM`.

**Tech Stack:** Next.js pages-router (apps/studio), React 19, TypeScript, vitest, pg-meta HTTP query channel, pgBackRest 2.58.0 (already in the `deluxebear/postgres:17` image), Docker/OrbStack.

## Global Constraints

- Studio is **management-plane ONLY**: no shell-out, no provisioning, no destructive ops. Observe-only. (spec §1)
- Self-hosted signal is **`IS_SELF_PLATFORM`** (`process.env.NEXT_PUBLIC_SELF_PLATFORM === 'true'`), NOT `!IS_PLATFORM` — management-plane runs `IS_PLATFORM=true`. (recon)
- Honest degradation: table/schema absent, malformed JSON, pg-meta error, or registry miss → return the empty `BackupsResponse` (`{ backups: [], physicalBackupData: {}, pitr_enabled: false, region: 'local', walg_enabled: false }`); never 500 the observe route. (spec §5.3)
- **stanza-agnostic**: never hardcode a stanza name; parse the full `pgbackrest info --output=json` array (0..N stanzas). Empty `[]` → honest-empty. (spec §5.1 correction; real operational stanza is `supabase`, owned by an external `supabase-admin-agent` not present in our world)
- **fixture-is-binding**: the pgbackrest info parser is written and tested against a REAL captured `pgbackrest info --output=json`, never an invented shape. (spec §8)
- U.S. English everywhere; every new user-facing string wrapped in `$t('...')` from `@/lib/i18n`. (CLAUDE.md + i18n skill)
- Tailwind semantic tokens only (`text-foreground-light` etc.), no hardcoded colors. (CLAUDE.md)
- Out of scope this milestone: restore (in-place/PITR/restore-to-new-project), on-demand trigger, logical backup (Tier 1), L2 registered-URL channel. (spec §9)
- Response type is exactly `paths['/platform/database/{ref}/backups']['get']['responses']['200']['content']['application/json']` (= `BackupsResponse`) from `api-types`. (recon §5)
- Ledger: record task briefs/reports under `.superpowers/sdd/` per the M6.x house flow; controller runs live E2E; Fable/Opus full-branch final review; merge decision stays with the user.

---

## File Structure

| File                                                                            | Responsibility                                                                            | Change          |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------- |
| `apps/studio/lib/api/self-platform/__fixtures__/pgbackrest-info-populated.json` | Real captured `pgbackrest info --output=json` with ≥1 backup                              | Create (Task 1) |
| `apps/studio/lib/api/self-platform/__fixtures__/pgbackrest-info-empty.json`     | Real captured empty envelope (`[]`)                                                       | Create (Task 1) |
| `apps/studio/lib/api/self-platform/backups.ts`                                  | Read status table + map pgbackrest-info JSON → `BackupsResponse`; honest-empty on failure | Create (Task 2) |
| `apps/studio/lib/api/self-platform/backups.test.ts`                             | Unit tests for parser + degradation                                                       | Create (Task 2) |
| `apps/studio/pages/api/platform/database/[ref]/backups.ts`                      | Route: `IS_SELF_PLATFORM` → guard READ + call lib; else keep M1 stub                      | Modify (Task 3) |
| `apps/studio/pages/api/platform/database/[ref]/backups.test.ts`                 | Handler-level tests (guard, self-platform mapped, plain stub, degrade)                    | Create (Task 3) |
| `apps/studio/components/interfaces/Database/Backups/BackupItem.tsx`             | Disable Restore under `IS_SELF_PLATFORM` + observe tooltip                                | Modify (Task 4) |
| `apps/studio/components/interfaces/Database/Backups/PITR/PITRStatus.tsx`        | Disable "Start a restore" under `IS_SELF_PLATFORM` + observe tooltip                      | Modify (Task 4) |
| `apps/studio/components/interfaces/Database/Backups/DatabaseBackupsNav.tsx`     | Hide restore-to-new-project tab under `IS_SELF_PLATFORM`                                  | Modify (Task 4) |
| `apps/studio/pages/project/[ref]/database/backups/scheduled.tsx`                | Observe-only + shared-db Admonition under `IS_SELF_PLATFORM`                              | Modify (Task 4) |
| `apps/studio/pages/project/[ref]/database/backups/pitr.tsx`                     | Observe-only + shared-db Admonition under `IS_SELF_PLATFORM`                              | Modify (Task 4) |
| `docs/self-hosted-parity/2026-07-07-F4-backups-operator-runbook.md`             | Operator contract: enable pgBackRest + publish status table (DDL + cron)                  | Create (Task 5) |

---

## Task 1: Capture real pgBackRest info fixtures

**Files:**

- Create: `apps/studio/lib/api/self-platform/__fixtures__/pgbackrest-info-empty.json`
- Create: `apps/studio/lib/api/self-platform/__fixtures__/pgbackrest-info-populated.json`

**Interfaces:**

- Produces: two fixture JSON files consumed by Task 2's parser tests. `pgbackrest-info-empty.json` is the literal `[]` (all-stanza, no backups). `pgbackrest-info-populated.json` is a real array `[{ name, status, backup: [{ label, type, timestamp: { start, stop }, ... }], archive: [{ id, min, max }], db: [...], repo: [...] }]` with ≥1 backup.

This is a **controlled execution spike** (mutates the running dev stack, then rolls back). It must be done by the controller with docker access, not a sandboxed subagent. Do NOT invent the JSON — capture it.

- [ ] **Step 1: Write the known-empty fixture (already captured)**

The real all-stanza empty envelope was captured during brainstorming: `docker exec supabase-db pgbackrest info --output=json` → `[]`. Write it:

```bash
printf '[]\n' > apps/studio/lib/api/self-platform/__fixtures__/pgbackrest-info-empty.json
```

- [ ] **Step 2: Configure a throwaway local repo + enable archiving on the dev db**

pgBackRest is already at `/usr/bin/pgbackrest` (2.58.0). Use a temporary posix repo and a temporary stanza `fixture` driven entirely by CLI flags (no conf-file edits). Enabling WAL archiving requires `archive_mode=on` (one restart).

```bash
docker exec supabase-db sh -lc 'mkdir -p /tmp/pgbrscratch && chown postgres:postgres /tmp/pgbrscratch'
# archive_mode=on + point archive_command at the scratch stanza (needs a restart to take effect)
docker exec -u postgres supabase-db psql -v ON_ERROR_STOP=1 -c "alter system set archive_mode = on;"
docker exec -u postgres supabase-db psql -v ON_ERROR_STOP=1 -c "alter system set archive_command = 'pgbackrest --stanza=fixture --repo1-path=/tmp/pgbrscratch --repo1-type=posix archive-push %p';"
docker restart supabase-db
# wait for readiness
until docker exec supabase-db pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
```

Expected: db restarts and becomes ready; `archive_mode` now `on`.

- [ ] **Step 3: stanza-create + full backup + capture populated JSON**

```bash
FLAGS="--stanza=fixture --repo1-path=/tmp/pgbrscratch --repo1-type=posix --pg1-path=/var/lib/postgresql/data --pg1-socket-path=/var/run/postgresql --no-backup-standby"
docker exec -u postgres supabase-db sh -lc "pgbackrest $FLAGS stanza-create"
docker exec -u postgres supabase-db sh -lc "pgbackrest $FLAGS check"
docker exec -u postgres supabase-db sh -lc "pgbackrest $FLAGS --type=full backup"
docker exec -u postgres supabase-db sh -lc "pgbackrest $FLAGS info --output=json" \
  | python3 -m json.tool > apps/studio/lib/api/self-platform/__fixtures__/pgbackrest-info-populated.json
```

Expected: `pgbackrest-info-populated.json` contains one stanza object with a non-empty `backup[]` array; note the real field names/values (especially `backup[].label`, `backup[].timestamp.start`/`stop`, and the `archive[]` array). If pgBackRest's real key names differ from the reference shape used in Task 2, Task 2's parser + test are written against THIS file.

- [ ] **Step 4: Roll back the dev stack to baseline**

```bash
docker exec -u postgres supabase-db psql -v ON_ERROR_STOP=1 -c "alter system reset archive_mode;"
docker exec -u postgres supabase-db psql -v ON_ERROR_STOP=1 -c "alter system reset archive_command;"
docker restart supabase-db
until docker exec supabase-db pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done
docker exec supabase-db sh -lc 'rm -rf /tmp/pgbrscratch'
# verify baseline restored
docker exec supabase-db psql -U postgres -tAc "select name||'='||setting from pg_settings where name in ('archive_mode','wal_level');"
docker exec supabase-db pgbackrest info --output=json
```

Expected: `archive_mode=off`, `wal_level=logical`, all-stanza `info` back to `[]` (the `fixture` stanza's repo lived only in `/tmp/pgbrscratch`, now removed).

- [ ] **Step 5: Commit the fixtures**

```bash
git add apps/studio/lib/api/self-platform/__fixtures__/pgbackrest-info-empty.json \
        apps/studio/lib/api/self-platform/__fixtures__/pgbackrest-info-populated.json
git commit -m "test(platform): F4 T1 — capture real pgbackrest info fixtures (empty + populated)"
```

---

## Task 2: `backups.ts` lib — parse pgbackrest info → BackupsResponse

**Files:**

- Create: `apps/studio/lib/api/self-platform/backups.ts`
- Test: `apps/studio/lib/api/self-platform/backups.test.ts`

**Interfaces:**

- Consumes: `resolveProjectConnection(ref)` → `{ pgConnEncrypted, ... }` from `./resolve-connection`; `constructHeaders` from `@/lib/api/apiHelpers`; `PG_META_URL` from `@/lib/constants`; fixtures from Task 1.
- Produces:
  - `export function mapPgbackrestInfo(info: unknown): BackupsResponse` — pure mapper (stanza-agnostic).
  - `export async function getProjectBackups(ref: string): Promise<BackupsResponse>` — reads the status table via pg-meta and maps it; honest-empty on any failure (re-throws only `ProjectNotFound`).
  - `BackupsResponse = paths['/platform/database/{ref}/backups']['get']['responses']['200']['content']['application/json']`.

- [ ] **Step 1: Write the failing test**

Create `apps/studio/lib/api/self-platform/backups.test.ts`. Structural assertions (robust to exact timestamps) + degradation, per the recon test pattern:

```ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getProjectBackups, mapPgbackrestInfo } from './backups'
import { resolveProjectConnection } from './resolve-connection'

vi.mock('./resolve-connection', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveProjectConnection: vi.fn(),
}))
vi.mock('@/lib/api/apiHelpers', () => ({
  constructHeaders: vi.fn((h: Record<string, string>) => h),
}))

const CONN = { ref: 'proj-x', pgConnEncrypted: 'enc-dsn' } as unknown as Awaited<
  ReturnType<typeof resolveProjectConnection>
>

const POPULATED = readFileSync(
  join(__dirname, '__fixtures__', 'pgbackrest-info-populated.json'),
  'utf8'
)

// pg-meta /query returns rows; jsonb `info` comes back parsed. Emulate a row
// { info: <parsed array> }. Accept a raw JSON string and hand back the parsed value.
const pgMetaMock = (infoValue: unknown) =>
  vi.fn().mockImplementation(async (url: unknown) => {
    if (String(url).includes('/query')) {
      return {
        ok: true,
        status: 200,
        json: async () => [{ info: infoValue }],
        text: async () => '',
      }
    }
    return { ok: true, status: 200, json: async () => [], text: async () => '' }
  })

beforeEach(() => {
  vi.mocked(resolveProjectConnection).mockReset().mockResolvedValue(CONN)
})
afterEach(() => vi.unstubAllGlobals())

describe('mapPgbackrestInfo', () => {
  it('maps a real populated pgbackrest info array to a physical BackupsResponse', () => {
    const res = mapPgbackrestInfo(JSON.parse(POPULATED))
    expect(res.backups.length).toBeGreaterThan(0)
    expect(res.backups[0]).toMatchObject({ isPhysicalBackup: true, status: 'COMPLETED' })
    expect(typeof res.backups[0].id).toBe('number')
    expect(typeof res.backups[0].inserted_at).toBe('string')
    expect(typeof res.physicalBackupData.earliestPhysicalBackupDateUnix).toBe('number')
    expect(typeof res.physicalBackupData.latestPhysicalBackupDateUnix).toBe('number')
    expect(res.region).toBe('local')
    expect(res.walg_enabled).toBe(false)
  })

  it('empty array → honest-empty response', () => {
    const res = mapPgbackrestInfo([])
    expect(res.backups).toEqual([])
    expect(res.physicalBackupData).toEqual({})
    expect(res.pitr_enabled).toBe(false)
  })

  it('non-array / garbage → honest-empty response', () => {
    expect(mapPgbackrestInfo(null).backups).toEqual([])
    expect(mapPgbackrestInfo({ nope: 1 }).backups).toEqual([])
  })
})

describe('getProjectBackups', () => {
  it('reads the status table over the encrypted-DSN channel and maps it', async () => {
    vi.stubGlobal('fetch', pgMetaMock(JSON.parse(POPULATED)))
    const res = await getProjectBackups('proj-x')
    expect(res.backups.length).toBeGreaterThan(0)
    const call = vi.mocked(fetch).mock.calls.find(([u]) => String(u).endsWith('/query'))!
    expect((call[1] as RequestInit).headers).toMatchObject({ 'x-connection-encrypted': 'enc-dsn' })
  })

  it('status table absent (pg-meta error) → honest-empty, no throw', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400 }))
    const res = await getProjectBackups('proj-x')
    expect(res.backups).toEqual([])
  })

  it('no row / empty info → honest-empty', async () => {
    vi.stubGlobal('fetch', pgMetaMock([]))
    const res = await getProjectBackups('proj-x')
    expect(res.backups).toEqual([])
  })

  it('info stored as a JSON string is parsed', async () => {
    vi.stubGlobal('fetch', pgMetaMock(POPULATED))
    const res = await getProjectBackups('proj-x')
    expect(res.backups.length).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter studio test -- backups.test.ts`
Expected: FAIL — `Cannot find module './backups'`.

- [ ] **Step 3: Write the minimal implementation**

Create `apps/studio/lib/api/self-platform/backups.ts`:

```ts
// [self-platform] F4 (Tier 2 observe): read operator-published pgBackRest
// status from the project DB and map it to the upstream BackupsResponse
// contract. Studio does not shell out or trigger backups — it observes a
// singleton status table an operator's backup cron populates with
// `pgbackrest info --output=json`. Absent/malformed → honest-empty response.
import type { paths } from 'api-types'

import { ProjectNotFound, resolveProjectConnection } from './resolve-connection'
import { constructHeaders } from '@/lib/api/apiHelpers'
import { PG_META_URL } from '@/lib/constants'

type BackupsResponse =
  paths['/platform/database/{ref}/backups']['get']['responses']['200']['content']['application/json']

const PROJECT_QUERY_TIMEOUT_MS = 5_000

// Operator-owned singleton status table:
//   _supabase_platform.pgbackrest_info(id int pk default 1, info jsonb, updated_at)
// where `info` is the verbatim `pgbackrest info --output=json` array.
const STATUS_SQL = 'select info from _supabase_platform.pgbackrest_info where id = 1'

const EMPTY: BackupsResponse = {
  backups: [],
  physicalBackupData: {},
  pitr_enabled: false,
  region: 'local',
  walg_enabled: false,
}

// Only the fields we map from a `pgbackrest info --output=json` stanza element.
interface PgbackrestStanza {
  name?: string
  backup?: { label?: string; type?: string; timestamp?: { start?: number; stop?: number } }[]
  archive?: { id?: string; min?: string | null; max?: string | null }[]
}

async function queryProjectDb(
  pgConnEncrypted: string,
  query: string
): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${PG_META_URL}/query`, {
    method: 'POST',
    headers: constructHeaders({
      'Content-Type': 'application/json',
      'x-connection-encrypted': pgConnEncrypted,
    }),
    body: JSON.stringify({ query }),
    signal: AbortSignal.timeout(PROJECT_QUERY_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`pg-meta HTTP ${response.status}`)
  return (await response.json()) as Record<string, unknown>[]
}

export function mapPgbackrestInfo(info: unknown): BackupsResponse {
  const stanzas: PgbackrestStanza[] = Array.isArray(info) ? (info as PgbackrestStanza[]) : []
  const backups: BackupsResponse['backups'] = []
  const starts: number[] = []
  let hasArchive = false

  for (const stanza of stanzas) {
    if (Array.isArray(stanza.archive) && stanza.archive.length > 0) hasArchive = true
    for (const b of stanza.backup ?? []) {
      const stop = b?.timestamp?.stop
      const start = b?.timestamp?.start
      if (typeof stop !== 'number') continue
      if (typeof start === 'number') starts.push(start)
      backups.push({
        // stop time is unique per backup; observe-only (UI keys on it, restore disabled).
        id: stop,
        inserted_at: new Date(stop * 1000).toISOString(),
        isPhysicalBackup: true,
        project_id: 0, // not consumed by the observe UI
        status: 'COMPLETED', // pgbackrest info only lists completed backups
      })
    }
  }

  if (backups.length === 0) return { ...EMPTY }

  return {
    backups,
    physicalBackupData: {
      earliestPhysicalBackupDateUnix: starts.length > 0 ? Math.min(...starts) : undefined,
      latestPhysicalBackupDateUnix: Math.max(...backups.map((b) => b.id)),
    },
    pitr_enabled: hasArchive,
    region: 'local',
    walg_enabled: false,
  }
}

export async function getProjectBackups(ref: string): Promise<BackupsResponse> {
  try {
    const conn = await resolveProjectConnection(ref)
    const rows = await queryProjectDb(conn.pgConnEncrypted, STATUS_SQL)
    const raw = rows[0]?.info
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    return mapPgbackrestInfo(parsed)
  } catch (err) {
    if (err instanceof ProjectNotFound) throw err // route surfaces this as 404
    console.log(
      `[self-platform] backups observe degraded for "${ref}": ${
        err instanceof Error ? err.message : String(err)
      }`
    )
    return { ...EMPTY }
  }
}
```

Note: if Task 1's real fixture shows different key names (e.g. the backup timestamp is nested differently), adjust `PgbackrestStanza` + the mapping in this step to match the fixture, and keep the test assertions structural.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter studio test -- backups.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck + lint the new module**

Run: `pnpm --filter studio exec tsc --noEmit` (or `pnpm typecheck`) and `pnpm lint --filter=studio`
Expected: 0 errors from the new files.

- [ ] **Step 6: Commit**

```bash
git add apps/studio/lib/api/self-platform/backups.ts apps/studio/lib/api/self-platform/backups.test.ts
git commit -m "feat(platform): F4 T2 — pgbackrest-info → BackupsResponse mapper (stanza-agnostic, honest-empty)"
```

---

## Task 3: Route wiring — observe under IS_SELF_PLATFORM

**Files:**

- Modify: `apps/studio/pages/api/platform/database/[ref]/backups.ts`
- Test: `apps/studio/pages/api/platform/database/[ref]/backups.test.ts`

**Interfaces:**

- Consumes: `getProjectBackups(ref)` (Task 2); `guardProjectRoute` from `@/lib/api/self-platform/rbac/enforce`; `PermissionAction.READ` from `@supabase/shared-types/out/constants`; `IS_SELF_PLATFORM` from `@/lib/constants/self-platform`.
- Produces: `export async function handler(req, res, claims?: JwtPayload)` returning a typed `BackupsResponse` (200) or the guard's 403/404.

- [ ] **Step 1: Write the failing test**

Create `apps/studio/pages/api/platform/database/[ref]/backups.test.ts`:

```ts
import type { NextApiRequest, NextApiResponse } from 'next'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './backups'
import { getProjectBackups } from '@/lib/api/self-platform/backups'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'

vi.mock('@/lib/constants/self-platform', () => ({ IS_SELF_PLATFORM: true }))
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardProjectRoute: vi.fn() }))
vi.mock('@/lib/api/self-platform/backups', () => ({ getProjectBackups: vi.fn() }))

const mkRes = () => {
  const res = {} as NextApiResponse & { _status?: number; _json?: unknown }
  res.status = vi.fn().mockImplementation((s: number) => {
    res._status = s
    return res
  }) as never
  res.json = vi.fn().mockImplementation((b: unknown) => {
    res._json = b
    return res
  }) as never
  res.setHeader = vi.fn() as never
  return res
}

beforeEach(() => {
  vi.mocked(guardProjectRoute).mockReset().mockResolvedValue(true)
  vi.mocked(getProjectBackups)
    .mockReset()
    .mockResolvedValue({
      backups: [
        { id: 1, inserted_at: 'x', isPhysicalBackup: true, project_id: 0, status: 'COMPLETED' },
      ],
      physicalBackupData: { earliestPhysicalBackupDateUnix: 1, latestPhysicalBackupDateUnix: 2 },
      pitr_enabled: true,
      region: 'local',
      walg_enabled: false,
    })
})
afterEach(() => vi.restoreAllMocks())

describe('GET /platform/database/[ref]/backups (self-platform)', () => {
  it('405s non-GET', async () => {
    const res = mkRes()
    await handler({ method: 'POST', query: { ref: 'proj-x' } } as unknown as NextApiRequest, res)
    expect(res._status).toBe(405)
  })

  it('guards with READ and returns the mapped observe response', async () => {
    const res = mkRes()
    await handler(
      { method: 'GET', query: { ref: 'proj-x' } } as unknown as NextApiRequest,
      res,
      {} as never
    )
    expect(guardProjectRoute).toHaveBeenCalledWith(
      res,
      expect.anything(),
      expect.objectContaining({ projectRef: 'proj-x', action: 'read:Read' })
    )
    expect(res._status).toBe(200)
    expect((res._json as { pitr_enabled: boolean }).pitr_enabled).toBe(true)
  })

  it('stops when the guard denies (no body written by handler)', async () => {
    vi.mocked(guardProjectRoute).mockResolvedValue(false)
    const res = mkRes()
    await handler(
      { method: 'GET', query: { ref: 'proj-x' } } as unknown as NextApiRequest,
      res,
      {} as never
    )
    expect(getProjectBackups).not.toHaveBeenCalled()
    expect(res.json).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter studio test -- "database/[ref]/backups.test.ts"`
Expected: FAIL — current handler ignores `IS_SELF_PLATFORM`/guard and always returns the static stub, so the guard/`getProjectBackups` assertions fail.

- [ ] **Step 3: Rewrite the route**

Replace the full contents of `apps/studio/pages/api/platform/database/[ref]/backups.ts`:

```ts
// [self-platform] Under management-plane self-platform, observe an
// operator-deployed pgBackRest state (RBAC READ, honest-empty on failure).
// Plain self-hosted keeps the M1 static stub — no managed backup system.
import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import type { paths } from 'api-types'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { getProjectBackups } from '@/lib/api/self-platform/backups'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

type BackupsResponse =
  paths['/platform/database/{ref}/backups']['get']['responses']['200']['content']['application/json']

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: true })

// [self-platform] exported for handler-level tests
export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res
      .status(405)
      .json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }

  if (IS_SELF_PLATFORM) {
    const ok = await guardProjectRoute(res, claims, {
      action: PermissionAction.READ,
      projectRef: String(req.query.ref),
    })
    if (!ok) return
    const response = await getProjectBackups(String(req.query.ref))
    return res.status(200).json(response)
  }

  // Plain self-hosted: M1 static stub — no managed backup system.
  const response: BackupsResponse = {
    backups: [],
    physicalBackupData: {},
    pitr_enabled: false,
    region: 'local',
    walg_enabled: false,
  }
  return res.status(200).json(response)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter studio test -- "database/[ref]/backups.test.ts"`
Expected: PASS.

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm --filter studio exec tsc --noEmit` and `pnpm lint --filter=studio`
Expected: 0 errors from the changed files.

- [ ] **Step 6: Commit**

```bash
git add "apps/studio/pages/api/platform/database/[ref]/backups.ts" "apps/studio/pages/api/platform/database/[ref]/backups.test.ts"
git commit -m "feat(platform): F4 T3 — backups route observes pgBackRest under IS_SELF_PLATFORM (READ guard, stub fallback)"
```

---

## Task 4: Frontend observe-only degradation

**Files:**

- Modify: `apps/studio/components/interfaces/Database/Backups/BackupItem.tsx:47` (restore disable)
- Modify: `apps/studio/components/interfaces/Database/Backups/PITR/PITRStatus.tsx:63` (restore disable)
- Modify: `apps/studio/components/interfaces/Database/Backups/DatabaseBackupsNav.tsx:30` (hide rtnp tab)
- Modify: `apps/studio/pages/project/[ref]/database/backups/scheduled.tsx` (observe notice)
- Modify: `apps/studio/pages/project/[ref]/database/backups/pitr.tsx` (observe notice)

**Interfaces:**

- Consumes: `IS_SELF_PLATFORM` from `@/lib/constants/self-platform`; `Admonition` from `ui-patterns/admonition`; `$t` from `@/lib/i18n`.
- Produces: no exported API; behavioral change gated on `IS_SELF_PLATFORM`. Cloud path (`IS_SELF_PLATFORM=false`) is byte-unchanged.

Verification for this task is controller live E2E + typecheck/lint (these components have no unit tests; matches M6.x). Physical-backup Download is already hidden (`BackupItem.tsx:63` renders Download only for `!isPhysicalBackup`) — no change needed. The enable-physical CTA is not on any Backups page — no change needed.

- [ ] **Step 1: Disable Restore in `BackupItem.tsx`**

Add the import (top of file, with the other `@/` imports):

```ts
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'
```

Change the Restore `ButtonTooltip` (currently `BackupItem.tsx:45-61`) `disabled` and `tooltip`:

```tsx
<ButtonTooltip
  variant="default"
  disabled={IS_SELF_PLATFORM || !isHealthy || !canTriggerScheduledBackups}
  onClick={onSelectBackup}
  tooltip={{
    content: {
      side: 'bottom',
      text: IS_SELF_PLATFORM
        ? $t(
            'Restore from Studio is not available on self-hosted. Restore using the pgBackRest CLI runbook.'
          )
        : !isHealthy
          ? 'Cannot be restored as project is not active'
          : !canTriggerScheduledBackups
            ? 'You need additional permissions to trigger a restore'
            : undefined,
    },
  }}
>
  {$t('Restore')}
</ButtonTooltip>
```

- [ ] **Step 2: Disable "Start a restore" in `PITRStatus.tsx`**

Add the import:

```ts
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'
```

Change the `ButtonTooltip` (currently `PITRStatus.tsx:62-77`):

```tsx
<ButtonTooltip
  disabled={IS_SELF_PLATFORM || hasReadReplicas || !canTriggerPhysicalBackup}
  onClick={() => onSetConfiguration()}
  tooltip={{
    content: {
      side: 'left',
      text: IS_SELF_PLATFORM
        ? $t(
            'PITR restore from Studio is not available on self-hosted. Restore using the pgBackRest CLI runbook.'
          )
        : hasReadReplicas
          ? 'You will need to remove all read replicas first to trigger a PITR recovery'
          : !canTriggerPhysicalBackup
            ? 'You need additional permissions to trigger a PITR recovery'
            : undefined,
    },
  }}
>
  {$t('Start a restore')}
</ButtonTooltip>
```

- [ ] **Step 3: Hide the restore-to-new-project tab in `DatabaseBackupsNav.tsx`**

Add the import:

```ts
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'
```

Change the rtnp item `enabled` (currently `DatabaseBackupsNav.tsx:30`):

```ts
enabled: databaseRestoreToNewProject && cloud_provider !== 'FLY' && !IS_SELF_PLATFORM,
```

- [ ] **Step 4: Add the observe-only notice to `scheduled.tsx`**

`scheduled.tsx` already imports `Admonition` from `ui-patterns/admonition` and `$t`. Add the import:

```ts
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'
```

Immediately under `<DatabaseBackupsNav active="scheduled" />` (inside `PageHeaderNavigationTabs`'s sibling area — place it at the top of the page body), add:

```tsx
{
  IS_SELF_PLATFORM && (
    <Admonition
      type="default"
      title={$t('Observing operator-managed physical backups')}
      description={$t(
        'This page reflects the pgBackRest state your operator publishes. Physical backups and PITR cover the entire database instance (not a single logical database). Restores run via the pgBackRest CLI runbook, not from Studio.'
      )}
    />
  )
}
```

- [ ] **Step 5: Add the same notice to `pitr.tsx`**

Read `apps/studio/pages/project/[ref]/database/backups/pitr.tsx`, add the `IS_SELF_PLATFORM` import and, directly under its `<DatabaseBackupsNav active="pitr" />`, insert the identical `{IS_SELF_PLATFORM && (<Admonition ... />)}` block from Step 4 (import `Admonition` from `ui-patterns/admonition` if pitr.tsx does not already import it).

- [ ] **Step 6: Typecheck + lint + i18n key extraction**

Run: `pnpm --filter studio exec tsc --noEmit`; `pnpm lint --filter=studio`. If the repo's i18n codemod must see new `$t` keys, run the studio i18n sync per the `studio-i18n-sync` skill (do NOT hand-edit locale JSON).
Expected: 0 errors; new English strings registered.

- [ ] **Step 7: Controller live E2E**

Restart the dev server if needed (`pnpm dev:studio`, self-platform `.env.local`). Seed the project DB with the captured populated fixture to stand in for the operator cron, then drive the page:

```bash
# seed (project DB = supabase-db / postgres)
docker exec -i supabase-db psql -U postgres -v ON_ERROR_STOP=1 <<'SQL'
create schema if not exists _supabase_platform;
create table if not exists _supabase_platform.pgbackrest_info (
  id int primary key default 1 check (id = 1), info jsonb not null, updated_at timestamptz not null default now());
insert into _supabase_platform.pgbackrest_info(id, info)
  values (1, pg_read_file('/dev/stdin')::jsonb)  -- or paste the fixture JSON inline
  on conflict (id) do update set info = excluded.info, updated_at = now();
SQL
```

Then (browser via the platform Owner JWT, GoTrue :8110): open `…/database/backups/scheduled` and `…/database/backups/pitr`. Verify: scheduled list renders the seeded backup rows; PITR page shows the earliest/latest window; the "Restore" and "Start a restore" buttons are disabled with the self-hosted tooltip; the "Restore to new project" tab is absent; the observe Admonition shows. Screenshot each as evidence. Then clean up:

```bash
docker exec supabase-db psql -U postgres -c "drop schema if exists _supabase_platform cascade;"
```

- [ ] **Step 8: Commit**

```bash
git add apps/studio/components/interfaces/Database/Backups apps/studio/pages/project/[ref]/database/backups
git commit -m "feat(platform): F4 T4 — Backups page observe-only degradation under IS_SELF_PLATFORM (disable restore, hide RTNP, observe/shared-db notice)"
```

---

## Task 5: Operator runbook — enable pgBackRest + publish status table

**Files:**

- Create: `docs/self-hosted-parity/2026-07-07-F4-backups-operator-runbook.md`

**Interfaces:**

- Consumes: nothing in code. This is the operator contract the observe path depends on.
- Produces: documentation only. The status-table DDL here MUST match the SELECT in Task 2 (`_supabase_platform.pgbackrest_info(id int pk default 1, info jsonb, updated_at)`, singleton row).

- [ ] **Step 1: Write the runbook**

Create the doc with two parts, cross-checked against the real config found on the image:

1. **Enable pgBackRest (operator, on the db host):** configure a repo (posix/S3) in `/etc/pgbackrest/conf.d/`, set `archive_mode=on` + `archive_command` (one restart), `pgbackrest --stanza=<name> stanza-create` + `check`, and schedule a periodic `--type=full backup` (cron/systemd-timer). Note the fork's intended stanza name is `supabase` and its config skeleton already ships in the image (`/etc/pgbackrest/pgbackrest.conf`, `conf.d/{computed_globals,repo1,repo1_async,repo1_encrypted}.conf`).
2. **Publish status for Studio (operator):** the DDL below (verbatim) + append this to the backup cron so Studio can observe. Use the whole-array `pgbackrest info --output=json` (no `--stanza` filter):

```sql
create schema if not exists _supabase_platform;
create table if not exists _supabase_platform.pgbackrest_info (
  id          int         primary key default 1 check (id = 1),
  info        jsonb       not null,
  updated_at  timestamptz not null default now()
);
```

```sh
# after each backup, publish the current info snapshot (localhost, same host as pgbackrest)
pgbackrest info --output=json > /tmp/pgbrinfo.json
psql -v ON_ERROR_STOP=1 -c "insert into _supabase_platform.pgbackrest_info (id, info)
  values (1, pg_read_file('/tmp/pgbrinfo.json')::jsonb)
  on conflict (id) do update set info = excluded.info, updated_at = now();"
```

Document the honest-degradation contract: if the schema/table is absent, Studio shows the empty "no physical backups configured" state; Studio never writes this table.

- [ ] **Step 2: Verify the DDL matches the parser**

Confirm the table name, `id = 1` singleton, and `info jsonb` column match `STATUS_SQL` in `apps/studio/lib/api/self-platform/backups.ts`. (Manual check — no runtime.)

- [ ] **Step 3: Commit**

```bash
git add docs/self-hosted-parity/2026-07-07-F4-backups-operator-runbook.md
git commit -m "docs(platform): F4 T5 — operator runbook (enable pgBackRest + publish status table)"
```

---

## Self-Review

**Spec coverage** (against `docs/self-hosted-parity/2026-07-07-F4-backups-observe-design.md`):

- §4 data flow (operator cron → project-DB table → resolveProjectConnection → BackupsResponse, on-demand, no sampler) → Tasks 2+3+5. ✓
- §5.1 status table + stanza-agnostic → Task 2 (`STATUS_SQL`, `mapPgbackrestInfo` iterates array) + Task 5 (DDL/cron). ✓
- §5.2 mapping table (every BackupsResponse field) → Task 2 `mapPgbackrestInfo`. ✓
- §5.3 route three-state honest degradation → Task 2 (`getProjectBackups` swallows to empty) + Task 3 (guard + stub fallback) + tests. ✓
- §5.4 frontend light-up/degrade table → Task 4 (restore disable, rtnp hide, download already hidden, enable-CTA not present) + auto light-up via route. ✓
- §5.5 PITR honesty (backup-timestamp-bounded window) → Task 2 `physicalBackupData` from backup start/stop; observe notice in Task 4. ✓
- §6 RBAC read-only → Task 3 `PermissionAction.READ`. ✓
- §7 shared-db whole-instance note → Task 4 Admonition copy. ✓
- §8 fixture-is-binding → Task 1. ✓
- §9 out-of-scope (no restore/trigger/logical routes) → not implemented; restore surfaces disabled, restore routes remain unstubbed (UI-level honest degradation). ✓
- §10 pins (JSON shape, injection syntax, id stability, gating, cloud isolation, restart-rollback) → Task 1 (rollback), Task 2 (`id = stop`), Task 4 (`IS_SELF_PLATFORM` only, cloud unchanged), Task 5 (cron syntax). ✓

**Placeholder scan:** no TBD/TODO; all code blocks concrete. The one deferred detail (exact populated JSON key names) is explicitly bound to Task 1's real capture, with Task 2 assertions kept structural so they hold regardless. ✓

**Type consistency:** `getProjectBackups`/`mapPgbackrestInfo` names identical across Tasks 2/3; `BackupsResponse` type expression identical in Tasks 2/3; `IS_SELF_PLATFORM` import path identical across Tasks 3/4; `STATUS_SQL` table shape identical in Tasks 2/5. ✓
