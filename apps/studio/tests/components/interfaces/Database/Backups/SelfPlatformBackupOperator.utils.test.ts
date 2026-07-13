import { describe, expect, it } from 'vitest'

import {
  canExecuteRestore,
  canRollbackRestore,
} from '@/components/interfaces/Database/Backups/SelfPlatformBackupOperator.utils'

const plan = {
  id: 'plan-1',
  hash: 'exact-hash',
  expiresAt: '2026-07-13T12:00:00Z',
  recoveryTarget: '2026-07-13T10:00:00Z',
  impact: { serviceInterruption: 'Writes stop', affectedNodes: ['primary'], requiredBytes: 1 },
  blockers: [] as string[],
}

describe('canExecuteRestore', () => {
  it('requires the exact plan hash and no blockers', () => {
    expect(canExecuteRestore(plan, 'exact-hash')).toBe(true)
  })

  it.each([
    ['missing plan', null, 'exact-hash'],
    ['empty confirmation', plan, ''],
    ['changed hash', plan, 'other-hash'],
    ['plan blocker', { ...plan, blockers: ['Topology changed'] }, 'exact-hash'],
  ])('rejects %s', (_, candidate, confirmation) => {
    expect(canExecuteRestore(candidate, confirmation)).toBe(false)
  })
})

describe('canRollbackRestore', () => {
  const now = new Date('2026-07-13T10:00:00Z')
  const job = {
    id: 'job-1',
    type: 'restore',
    state: 'rollback-available' as const,
    progress: 100,
    updatedAt: '2026-07-13T09:59:00Z',
    rollbackUntil: '2026-07-13T11:00:00Z',
    manualIntervention: null,
  }

  it('allows rollback inside the advertised window', () => {
    expect(canRollbackRestore(job, now)).toBe(true)
  })

  it('rejects missing jobs, wrong states, missing windows, and expired windows', () => {
    expect(canRollbackRestore(undefined, now)).toBe(false)
    expect(canRollbackRestore({ ...job, state: 'succeeded' }, now)).toBe(false)
    expect(canRollbackRestore({ ...job, rollbackUntil: null }, now)).toBe(false)
    expect(canRollbackRestore({ ...job, rollbackUntil: now.toISOString() }, now)).toBe(false)
  })
})
