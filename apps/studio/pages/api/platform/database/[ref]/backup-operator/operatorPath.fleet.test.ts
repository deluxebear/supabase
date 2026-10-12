import type { JwtPayload } from '@supabase/supabase-js'
import type { NextApiRequest, NextApiResponse } from 'next'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './[...operatorPath]'
import { requireProjectCapability } from '@/lib/api/self-platform/attachment'
import { requestBackupOperator } from '@/lib/api/self-platform/backup-operator-client'
import { syncProjectManagementBinding } from '@/lib/api/self-platform/management-trust'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'

vi.mock('@/lib/constants/self-platform', () => ({ IS_SELF_PLATFORM: true }))
vi.mock('@/lib/constants/deployment-profile', () => ({
  STUDIO_DEPLOYMENT_PROFILE: 'fleet',
  STUDIO_CAPABILITIES: { backupManagement: true },
}))
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardProjectRoute: vi.fn() }))
vi.mock('@/lib/api/self-platform/attachment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/self-platform/attachment')>()),
  requireProjectCapability: vi.fn(),
}))
vi.mock('@/lib/api/self-platform/management-trust', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/self-platform/management-trust')>()),
  syncProjectManagementBinding: vi.fn(),
}))
vi.mock('@/lib/api/self-platform/backup-operator-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/self-platform/backup-operator-client')>()),
  requestBackupOperator: vi.fn(),
}))

function responseRecorder() {
  const response = {} as NextApiResponse & { statusCode?: number; body?: unknown }
  response.status = vi.fn((status: number) => {
    response.statusCode = status
    return response
  }) as never
  response.json = vi.fn((body: unknown) => {
    response.body = body
    return response
  }) as never
  response.setHeader = vi.fn(() => response) as never
  return response
}

const policyRequest = {
  method: 'GET',
  query: { ref: 'project-a', operatorPath: ['policy'] },
  headers: {},
} as unknown as NextApiRequest

beforeEach(() => {
  vi.mocked(guardProjectRoute).mockReset().mockResolvedValue(true)
  vi.mocked(requireProjectCapability).mockReset().mockResolvedValue(undefined)
  vi.mocked(syncProjectManagementBinding).mockReset()
  vi.mocked(requestBackupOperator).mockReset().mockResolvedValue({ ok: true })
})

describe('Fleet Backup Operator proxy', () => {
  it('refreshes Agent capability evidence before checking the Agent connection', async () => {
    vi.mocked(syncProjectManagementBinding).mockResolvedValue(
      {} as Awaited<ReturnType<typeof syncProjectManagementBinding>>
    )
    const response = responseRecorder()
    await handler(policyRequest, response, { sub: 'owner', aal: 'aal1' } as JwtPayload)

    expect(response.statusCode).toBe(200)
    expect(syncProjectManagementBinding).toHaveBeenCalledWith({
      projectRef: 'project-a',
      actor: 'owner',
    })
    expect(vi.mocked(syncProjectManagementBinding).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(requireProjectCapability).mock.invocationCallOrder[0]
    )
  })

  it('still reports the capability check when Fleet Control cannot be reached', async () => {
    vi.mocked(syncProjectManagementBinding).mockRejectedValue(new Error('unreachable'))
    const response = responseRecorder()
    await handler(policyRequest, response, { sub: 'owner', aal: 'aal1' } as JwtPayload)

    expect(requireProjectCapability).toHaveBeenCalledWith('project-a', 'management.agent.connect')
    expect(response.statusCode).toBe(200)
  })
})
