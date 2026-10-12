import type { NextApiRequest, NextApiResponse } from 'next'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './status'
import { getBackupManagementAvailability } from '@/lib/api/self-platform/backup-management-availability'
import {
  BackupOperatorAPIError,
  requestBackupOperator,
} from '@/lib/api/self-platform/backup-operator-client'
import { getBackupOperatorStatus } from '@/lib/api/self-platform/backup-operator-status'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'

vi.mock('@/lib/constants/self-platform', () => ({ IS_SELF_PLATFORM: true }))
vi.mock('@/lib/constants/deployment-profile', () => ({
  STUDIO_DEPLOYMENT_PROFILE: 'fleet',
  STUDIO_CAPABILITIES: { backupManagement: true },
}))
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardProjectRoute: vi.fn() }))
vi.mock('@/lib/api/self-platform/backup-management-availability', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/lib/api/self-platform/backup-management-availability')
  >()),
  getBackupManagementAvailability: vi.fn(),
}))
vi.mock('@/lib/api/self-platform/backup-operator-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/self-platform/backup-operator-client')>()),
  requestBackupOperator: vi.fn(),
}))
vi.mock('@/lib/api/self-platform/backup-operator-status', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/self-platform/backup-operator-status')>()),
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
  vi.mocked(getBackupManagementAvailability).mockReset().mockResolvedValue({
    state: 'available',
    configured: true,
    blockers: [],
    correlationId: '00000000-0000-4000-8000-000000000019',
  })
  vi.mocked(requestBackupOperator)
    .mockReset()
    .mockImplementation(async (_ref, path) => (path === '' ? cluster : policy))
})

const cluster = {
  targetId: 'project-ref',
  discovery: {
    provider: 'single-primary-pgbackrest',
    topology: 'static-primary',
    primary: 'project-ref-db',
    standbys: [],
    repositoryType: 'pgbackrest',
    repositoryLocation: 's3://fleet-backup-project-ref/pgbackrest',
    blockers: [],
    observedAt: '2026-10-12T06:00:00Z',
  },
}
const policy = { enabled: true, retentionDays: 7, fullSchedule: '0 2 * * *', backupFrom: 'primary' }

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
    expect(getBackupOperatorStatus).not.toHaveBeenCalled()
    expect(response.statusCode).toBe(200)
    expect(response.body).toMatchObject({
      configured: true,
      policy: { enabled: true, retentionDays: 7, schedule: '0 2 * * *' },
      topology: { kind: 'static-primary', primary: 'project-ref-db' },
      check: { status: 'healthy', checkedAt: '2026-10-12T06:00:00Z' },
      capabilities: { backup: true, restore: true },
      management: { state: 'available', correlationId: expect.any(String) },
    })
  })

  it('reports a project without backups as available but not configured', async () => {
    vi.mocked(requestBackupOperator).mockRejectedValue(
      new BackupOperatorAPIError('not_found', 'cluster not found', 404)
    )
    const response = makeResponse()
    await handler(
      { method: 'GET', query: { ref: 'project-ref' } } as unknown as NextApiRequest,
      response,
      {} as never
    )

    expect(response.body).toMatchObject({ configured: false, management: { state: 'available' } })
  })

  it('reports a registered cluster without a recent observation as degraded', async () => {
    vi.mocked(requestBackupOperator).mockImplementation(async (_ref, path) => {
      if (path === '') {
        throw new BackupOperatorAPIError('cluster_discovery_failed', 'no recent observation', 409)
      }
      return policy
    })
    const response = makeResponse()
    await handler(
      { method: 'GET', query: { ref: 'project-ref' } } as unknown as NextApiRequest,
      response,
      {} as never
    )

    expect(response.body).toMatchObject({
      configured: true,
      check: { status: 'degraded', message: 'no recent observation' },
      capabilities: { restore: false },
      management: { state: 'available' },
    })
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

  it('returns setup guidance instead of probing an unconfigured Backup domain', async () => {
    vi.mocked(getBackupManagementAvailability).mockResolvedValue({
      state: 'unconfigured',
      configured: false,
      blockers: [{ code: 'backup_management_unconfigured', message: 'Configure Backup.' }],
      correlationId: '00000000-0000-4000-8000-000000000020',
    })
    const response = makeResponse()
    await handler(
      { method: 'GET', query: { ref: 'project-ref' } } as unknown as NextApiRequest,
      response,
      {} as never
    )

    expect(response.statusCode).toBe(200)
    expect(response.body).toMatchObject({ management: { state: 'unconfigured' } })
    expect(requestBackupOperator).not.toHaveBeenCalled()
    expect(getBackupOperatorStatus).not.toHaveBeenCalled()
  })

  it('turns a failed readiness probe into a correlated offline state', async () => {
    vi.mocked(requestBackupOperator).mockRejectedValue(new Error('connect ECONNREFUSED'))
    const response = makeResponse()
    await handler(
      { method: 'GET', query: { ref: 'project-ref' } } as unknown as NextApiRequest,
      response,
      {} as never
    )

    expect(response.statusCode).toBe(200)
    expect(response.body).toMatchObject({
      management: {
        state: 'offline',
        blockers: [{ code: 'backup_domain_offline' }],
      },
    })
    expect(getBackupOperatorStatus).not.toHaveBeenCalled()
  })

  it('recovers a previously unavailable domain after a successful readiness probe', async () => {
    vi.mocked(getBackupManagementAvailability).mockResolvedValue({
      state: 'checking',
      configured: true,
      blockers: [{ code: 'backup_domain_rechecking', message: 'Checking again.' }],
      correlationId: '00000000-0000-4000-8000-000000000021',
    })
    const response = makeResponse()
    await handler(
      { method: 'GET', query: { ref: 'project-ref' } } as unknown as NextApiRequest,
      response,
      {} as never
    )

    expect(requestBackupOperator).toHaveBeenCalledWith(
      'project-ref',
      '',
      expect.objectContaining({ correlationId: '00000000-0000-4000-8000-000000000021' })
    )
    expect(response.body).toMatchObject({
      configured: true,
      management: { state: 'available', blockers: [] },
    })
  })
})
