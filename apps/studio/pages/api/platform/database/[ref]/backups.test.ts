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
