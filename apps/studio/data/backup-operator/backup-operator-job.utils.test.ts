import { describe, expect, it } from 'vitest'

import { isActiveBackupOperatorJob } from './backup-operator-job.utils'
import { operatorJobSchema } from './schemas'

describe('isActiveBackupOperatorJob', () => {
  it.each(['queued', 'running'] as const)('treats %s as active', (state) => {
    expect(isActiveBackupOperatorJob(state)).toBe(true)
  })

  it.each([
    'succeeded',
    'failed',
    'cancelled',
    'orphaned',
    'manual-intervention',
    'rollback-available',
  ] as const)('treats %s as terminal', (state) => {
    expect(isActiveBackupOperatorJob(state)).toBe(false)
  })

  it('does not start polling before a job snapshot is available', () => {
    expect(isActiveBackupOperatorJob(undefined)).toBe(false)
  })
})

describe('operatorJobSchema', () => {
  it('preserves typed execution evidence and attempt history', () => {
    const job = operatorJobSchema.parse({
      id: 'job-a',
      type: 'backup',
      state: 'succeeded',
      progress: 100,
      updatedAt: '2026-07-17T01:02:03Z',
      rollbackUntil: null,
      manualIntervention: null,
      evidence: { backupLabel: '20260717-010203F', repositoryId: 'repo-a' },
      attempts: [
        {
          name: 'execute',
          state: 'succeeded',
          attempt: 1,
          updatedAt: '2026-07-17T01:02:03Z',
        },
      ],
    })

    expect(job.evidence?.backupLabel).toBe('20260717-010203F')
    expect(job.attempts).toHaveLength(1)
  })
})
