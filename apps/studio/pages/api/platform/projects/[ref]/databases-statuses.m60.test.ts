import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './databases-statuses'
import { probeStackHealth, writeThroughStatus } from '@/lib/api/self-platform/health'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
})

vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardProjectRoute: vi.fn() }))
vi.mock('@/lib/api/self-platform/health', () => ({
  probeStackHealth: vi.fn(),
  writeThroughStatus: vi.fn(),
}))

const claimsOf = (sub: string) => ({ sub }) as JwtPayload

beforeEach(() => {
  vi.mocked(guardProjectRoute).mockReset().mockResolvedValue(true)
  vi.mocked(probeStackHealth).mockReset()
  vi.mocked(writeThroughStatus).mockReset().mockResolvedValue(undefined)
})

describe('GET /platform/projects/[ref]/databases-statuses (self-platform)', () => {
  it('M6.0: status comes from the db probe (UNHEALTHY propagates)', async () => {
    vi.mocked(probeStackHealth).mockResolvedValue({
      results: [{ name: 'db', status: 'UNHEALTHY', healthy: false, error: 'x' }],
      fresh: true,
    } as never)
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-x' } })
    await handler(req as never, res as never, claimsOf('g-1'))
    expect(res._getJSONData()).toEqual([{ identifier: 'default', status: 'UNHEALTHY' }])
    expect(writeThroughStatus).toHaveBeenCalled()
  })

  it('M6.0: healthy db keeps ACTIVE_HEALTHY', async () => {
    vi.mocked(probeStackHealth).mockResolvedValue({
      results: [{ name: 'db', status: 'ACTIVE_HEALTHY', healthy: true }],
      fresh: false,
    } as never)
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-x' } })
    await handler(req as never, res as never, claimsOf('g-1'))
    expect(res._getJSONData()).toEqual([{ identifier: 'default', status: 'ACTIVE_HEALTHY' }])
    expect(writeThroughStatus).not.toHaveBeenCalled()
  })
})
