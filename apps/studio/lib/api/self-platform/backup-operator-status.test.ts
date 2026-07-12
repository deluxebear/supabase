import { describe, expect, it } from 'vitest'

import {
  backupOperatorStatusSchema,
  unavailableBackupOperatorStatus,
} from './backup-operator-status'

describe('backupOperatorStatusSchema', () => {
  it('accepts the unavailable status projection', () => {
    expect(backupOperatorStatusSchema.parse(unavailableBackupOperatorStatus)).toEqual(
      unavailableBackupOperatorStatus
    )
  })

  it('accepts a ready self-hosted operator status', () => {
    const result = backupOperatorStatusSchema.safeParse({
      ...unavailableBackupOperatorStatus,
      configured: true,
      policy: {
        enabled: true,
        retentionDays: 7,
        schedule: '0 2 * * *',
        backupFrom: 'standby',
      },
      capabilities: { backup: true, restore: true, blockers: [] },
      compatibility: {
        image: 'deluxebear/postgres:17',
        supported: true,
        blocker: null,
      },
    })

    expect(result.success).toBe(true)
  })

  it('rejects an unsupported backup source', () => {
    const result = backupOperatorStatusSchema.safeParse({
      ...unavailableBackupOperatorStatus,
      policy: { ...unavailableBackupOperatorStatus.policy, backupFrom: 'automatic' },
    })

    expect(result.success).toBe(false)
  })
})
