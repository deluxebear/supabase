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

    // Exact-value assertions against the real fixture (2 backups: full then incr).
    expect(res.backups.length).toBe(2)
    expect(res.physicalBackupData.earliestPhysicalBackupDateUnix).toBe(1783418400)
    expect(res.physicalBackupData.latestPhysicalBackupDateUnix).toBe(1783422004)
    expect(res.pitr_enabled).toBe(true)
    for (const b of res.backups) {
      expect(b.isPhysicalBackup).toBe(true)
      expect(b.status).toBe('COMPLETED')
      expect(typeof b.id).toBe('number')
    }
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

  it('nested garbage inside an array → honest-empty response, no throw', () => {
    expect(mapPgbackrestInfo([null]).backups).toEqual([])
    expect(mapPgbackrestInfo([{ backup: 5 }]).backups).toEqual([])
    expect(mapPgbackrestInfo([{ archive: 'x' }]).backups).toEqual([])
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
