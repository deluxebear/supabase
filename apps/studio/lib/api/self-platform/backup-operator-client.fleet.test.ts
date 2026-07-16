import { beforeEach, describe, expect, it, vi } from 'vitest'

import { requestBackupOperator } from './backup-operator-client'
import { getProjectManagementBinding, requestManagementDomain } from './management-trust'
import { resolveProjectConnection } from './resolve-connection'

vi.mock('@/lib/constants/deployment-profile', () => ({ STUDIO_DEPLOYMENT_PROFILE: 'fleet' }))
vi.mock('./resolve-connection', () => ({ resolveProjectConnection: vi.fn() }))
vi.mock('./management-trust', () => ({
  getProjectManagementBinding: vi.fn(),
  requestManagementDomain: vi.fn(),
}))

describe('Backup Operator Fleet management trust client', () => {
  beforeEach(() => {
    vi.mocked(resolveProjectConnection)
      .mockReset()
      .mockResolvedValue({
        row: { stack_meta: { backupOperatorClusterId: 'cluster-a' } },
      } as never)
    vi.mocked(getProjectManagementBinding)
      .mockReset()
      .mockResolvedValue({
        id: 'binding-a',
        projectRef: 'project-a',
      } as never)
    vi.mocked(requestManagementDomain).mockReset().mockResolvedValue({ ok: true })
  })

  it('forwards project scope, stable idempotency, and verified AAL2 through the target', async () => {
    await expect(
      requestBackupOperator('project-a', '/restore-plans/plan-a/confirm', {
        method: 'POST',
        body: { planHash: 'hash-a' },
        actor: 'owner-a',
        aal: 'aal2',
        aalAuthenticatedAt: 1_700_000_000,
        correlationId: 'correlation-a',
      })
    ).resolves.toEqual({ ok: true })

    expect(requestManagementDomain).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'binding-a', projectRef: 'project-a' }),
      'backup-operator',
      expect.objectContaining({
        projectId: 'cluster-a',
        actor: 'owner-a',
        aal: 'aal2',
        aalAuthenticatedAt: 1_700_000_000,
        correlationId: 'correlation-a',
        idempotencyKey: expect.stringMatching(/^[a-f0-9]{64}$/),
        scopes: ['restore.execute'],
      })
    )
  })

  it('uses least-privilege scopes for reads and non-restore writes', async () => {
    await requestBackupOperator('project-a', '/backup-policy')
    expect(requestManagementDomain).toHaveBeenLastCalledWith(
      expect.anything(),
      'backup-operator',
      expect.objectContaining({ scopes: ['backup.read'] })
    )

    await requestBackupOperator('project-a', '/backups', { method: 'POST', body: { type: 'full' } })
    expect(requestManagementDomain).toHaveBeenLastCalledWith(
      expect.anything(),
      'backup-operator',
      expect.objectContaining({ scopes: ['backup.write'] })
    )
  })
})
