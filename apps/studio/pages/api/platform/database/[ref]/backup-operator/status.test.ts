import type { NextApiRequest, NextApiResponse } from 'next'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './status'
import { getBackupOperatorStatus } from '@/lib/api/self-platform/backup-operator-status'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'

vi.mock('@/lib/constants/self-platform', () => ({ IS_SELF_PLATFORM: true }))
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardProjectRoute: vi.fn() }))
vi.mock('@/lib/api/self-platform/backup-operator-status', () => ({
  getBackupOperatorStatus: vi.fn(),
}))

const makeResponse = () => {
  const response = {} as NextApiResponse & { statusCode?: number; body?: unknown }
  response.status = vi.fn().mockImplementation((statusCode: number) => {
    response.statusCode = statusCode
    return response
  }) as never
  response.json = vi.fn().mockImplementation((body: unknown) => {
    response.body = body
    return response
  }) as never
  response.setHeader = vi.fn() as never
  return response
}

beforeEach(() => {
  vi.mocked(guardProjectRoute).mockReset().mockResolvedValue(true)
  vi.mocked(getBackupOperatorStatus)
    .mockReset()
    .mockResolvedValue({ configured: true } as never)
})

describe('GET /platform/database/[ref]/backup-operator/status', () => {
  it('rejects non-GET methods', async () => {
    const response = makeResponse()
    await handler(
      { method: 'POST', query: { ref: 'project-ref' } } as unknown as NextApiRequest,
      response
    )

    expect(response.statusCode).toBe(405)
  })

  it('guards project read access before returning the projection', async () => {
    const response = makeResponse()
    await handler(
      { method: 'GET', query: { ref: 'project-ref' } } as unknown as NextApiRequest,
      response,
      {} as never
    )

    expect(guardProjectRoute).toHaveBeenCalledWith(
      response,
      expect.anything(),
      expect.objectContaining({ projectRef: 'project-ref', action: 'read:Read' })
    )
    expect(getBackupOperatorStatus).toHaveBeenCalledWith('project-ref')
    expect(response.statusCode).toBe(200)
  })

  it('does not read status when access is denied', async () => {
    vi.mocked(guardProjectRoute).mockResolvedValue(false)
    const response = makeResponse()
    await handler(
      { method: 'GET', query: { ref: 'project-ref' } } as unknown as NextApiRequest,
      response,
      {} as never
    )

    expect(getBackupOperatorStatus).not.toHaveBeenCalled()
  })
})
