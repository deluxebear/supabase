import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './projects-resource-warnings'
import { executePlatformQuery } from '@/lib/api/self-platform/db'
import { listAllProjectsV2 } from '@/lib/api/self-platform/list-user-projects'
import { getMemberContext } from '@/lib/api/self-platform/members'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})
vi.mock('@/lib/api/self-platform/db', () => ({ executePlatformQuery: vi.fn() }))
vi.mock('@/lib/api/self-platform/members', () => ({ getMemberContext: vi.fn() }))
vi.mock('@/lib/api/self-platform/list-user-projects', () => ({ listAllProjectsV2: vi.fn() }))

const CLAIMS = { sub: 'g-1' } as never
const CTX = { gotrueId: 'g-1', roles: [] } as never

const sample = (ref: string, attribute: string, value: number) => ({
  project_ref: ref,
  attribute,
  value,
})

const run = async (query: Record<string, unknown> = {}) => {
  const { req, res } = createMocks({ method: 'GET', query })
  await handler(req as never, res as never, CLAIMS)
  return res
}

beforeEach(() => {
  vi.mocked(getMemberContext).mockReset().mockResolvedValue(CTX)
  vi.mocked(listAllProjectsV2)
    .mockReset()
    .mockResolvedValue({
      pagination: { count: 2, limit: 100, offset: 0 },
      projects: [{ ref: 'proj-a' }, { ref: 'proj-b' }],
    } as never)
  vi.mocked(executePlatformQuery).mockReset().mockResolvedValue({ data: [], error: undefined })
})

describe('GET projects-resource-warnings (self-platform)', () => {
  it('derives exhaustion levels from latest samples (90/80 thresholds)', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({
      data: [
        sample('proj-a', 'avg_cpu_usage', 92),
        sample('proj-a', 'ram_usage', 85),
        sample('proj-a', 'disk_fs_used', 50),
        sample('proj-a', 'disk_fs_size', 100),
      ] as never,
      error: undefined,
    })
    const res = await run()
    const rows = res._getJSONData()
    const a = rows.find((r: { project: string }) => r.project === 'proj-a')
    expect(a).toMatchObject({
      project: 'proj-a',
      cpu_exhaustion: 'critical',
      memory_and_swap_exhaustion: 'warning',
      disk_space_exhaustion: null,
      is_readonly_mode_enabled: false,
      auth_email_offender: null,
      auth_rate_limit_exhaustion: null,
      auth_restricted_email_sending: null,
      disk_io_exhaustion: null,
      need_pitr: null,
    })
  })
  it('pins the exact 90/80 boundary thresholds for cpu_exhaustion', async () => {
    const cases: Array<[number, 'critical' | 'warning' | null]> = [
      [79, null],
      [80, 'warning'],
      [89, 'warning'],
      [90, 'critical'],
    ]
    for (const [value, expected] of cases) {
      vi.mocked(executePlatformQuery).mockResolvedValue({
        data: [sample('proj-a', 'avg_cpu_usage', value)] as never,
        error: undefined,
      })
      const res = await run()
      const a = res._getJSONData().find((r: { project: string }) => r.project === 'proj-a')
      expect(a.cpu_exhaustion).toBe(expected)
    }
  })
  it('disk percent derives from disk_fs_used / disk_fs_size', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({
      data: [sample('proj-a', 'disk_fs_used', 95), sample('proj-a', 'disk_fs_size', 100)] as never,
      error: undefined,
    })
    const res = await run()
    const a = res._getJSONData().find((r: { project: string }) => r.project === 'proj-a')
    expect(a.disk_space_exhaustion).toBe('critical')
    expect(a.cpu_exhaustion).toBeNull() // no cpu sample → null, never 0-derived
  })
  it('projects without samples get an all-null row (honest)', async () => {
    const res = await run()
    const rows = res._getJSONData()
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.cpu_exhaustion).toBeNull()
      expect(row.memory_and_swap_exhaustion).toBeNull()
      expect(row.disk_space_exhaustion).toBeNull()
    }
  })
  it('honors the ref filter param', async () => {
    const res = await run({ ref: 'proj-b' })
    const rows = res._getJSONData()
    expect(rows).toHaveLength(1)
    expect(rows[0].project).toBe('proj-b')
  })
  it('staleness window rides in the SQL (last 5 minutes)', async () => {
    await run()
    const [opts] = vi.mocked(executePlatformQuery).mock.calls[0]
    expect(opts.query).toContain("interval '5 minutes'")
  })
  it('missing claims → 401', async () => {
    const { req, res } = createMocks({ method: 'GET' })
    await handler(req as never, res as never, undefined)
    expect(res._getStatusCode()).toBe(401)
  })
})
