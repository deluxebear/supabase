import { beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchBackupOperator } from '@/data/backup-operator/backup-operator-fetch'

vi.mock('@/data/backup-operator/backup-operator-fetch', () => ({
  fetchBackupOperator: vi.fn(),
}))

beforeEach(() => vi.mocked(fetchBackupOperator).mockReset())

describe('getBackupOperatorStatus', () => {
  it('returns the authenticated status projection', async () => {
    vi.mocked(fetchBackupOperator).mockResolvedValue(
      Response.json({
        configured: true,
        policy: {
          enabled: true,
          retentionDays: 7,
          schedule: '0 2 * * *',
          backupFrom: 'primary',
        },
        provider: { name: 'pgBackRest', version: '2.55' },
        topology: { kind: 'single', primary: 'db', standbys: 0 },
        repository: { type: 'posix', location: '/backups' },
        check: { status: 'healthy', checkedAt: '2026-07-16T12:00:00Z', message: null },
        lastJob: { type: 'full', state: 'succeeded', finishedAt: '2026-07-16T11:00:00Z' },
        capabilities: { backup: true, restore: true, blockers: [] },
        compatibility: { image: 'postgres:15', supported: true, blocker: null },
        updatedAt: '2026-07-16T12:00:00Z',
      })
    )
    const { getBackupOperatorStatus } = await import('./backup-operator-status-query')

    const status = await getBackupOperatorStatus({ projectRef: 'project-a' })

    expect(status.configured).toBe(true)
    expect(fetchBackupOperator).toHaveBeenCalledWith(
      expect.stringContaining('/project-a/backup-operator/status'),
      expect.objectContaining({ signal: undefined })
    )
  })

  it.each([401, 403])('surfaces HTTP %s authorization failures explicitly', async (code) => {
    vi.mocked(fetchBackupOperator).mockResolvedValue(
      Response.json(
        { message: code === 401 ? 'Authentication required' : 'Backup access denied' },
        { status: code }
      )
    )
    const { getBackupOperatorStatus } = await import('./backup-operator-status-query')

    await expect(getBackupOperatorStatus({ projectRef: 'project-a' })).rejects.toMatchObject({
      code,
      message: code === 401 ? 'Authentication required' : 'Backup access denied',
    })
  })
})
