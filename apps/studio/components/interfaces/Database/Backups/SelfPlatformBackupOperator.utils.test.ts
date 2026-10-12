import { describe, expect, it } from 'vitest'

import { getDrillStatusMessage } from './SelfPlatformBackupOperator.utils'

describe('getDrillStatusMessage', () => {
  it('stays silent when a restore drill verified the window', () => {
    expect(getDrillStatusMessage('verified')).toBeNull()
  })

  it.each(['none', 'failed', 'older-than-latest-backup', 'mismatch'] as const)(
    'explains the %s state',
    (status) => {
      expect(getDrillStatusMessage(status)).toEqual(expect.any(String))
    }
  )

  it('says the next drill is automatic when the last one covers an older backup', () => {
    expect(getDrillStatusMessage('older-than-latest-backup')).toMatch(/older backup/)
  })
})
