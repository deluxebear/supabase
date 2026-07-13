import { describe, expect, it } from 'vitest'

import { isActiveBackupOperatorJob } from './backup-operator-job.utils'

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
