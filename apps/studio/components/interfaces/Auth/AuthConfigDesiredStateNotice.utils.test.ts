import { describe, expect, it } from 'vitest'

import { getAuthApplyNotice } from './AuthConfigDesiredStateNotice.utils'
import type { AuthConfigApplyStatus } from '@/data/auth/auth-config-apply'

const status = (overrides: Partial<AuthConfigApplyStatus>): AuthConfigApplyStatus => ({
  availability: { isAvailable: true },
  state: 'pending',
  isOwnedByFleet: true,
  appliedFields: ['SITE_URL'],
  sealedSecretFields: [],
  skippedSecretFields: [],
  expectedGeneration: 1,
  operation: null,
  ...overrides,
})

describe('getAuthApplyNotice', () => {
  it('falls back to the saved-only message without a status', () => {
    expect(getAuthApplyNotice(undefined)).toEqual({ kind: 'saved-only', reason: null })
  })

  it('hides the notice when the service already uses the stored settings', () => {
    expect(getAuthApplyNotice(status({ state: 'applied' }))).toEqual({ kind: 'hidden' })
    expect(getAuthApplyNotice(status({ state: 'nothing-to-apply' }))).toEqual({ kind: 'hidden' })
  })

  it('explains why applying is unavailable', () => {
    expect(
      getAuthApplyNotice(
        status({ availability: { isAvailable: false, code: 'x', message: 'No Agent' } })
      )
    ).toEqual({ kind: 'saved-only', reason: 'No Agent' })
  })

  it('offers to apply pending settings and reports progress and failures', () => {
    expect(getAuthApplyNotice(status({ state: 'pending' }))).toEqual({ kind: 'pending' })
    expect(getAuthApplyNotice(status({ state: 'applying' }))).toEqual({ kind: 'applying' })
    expect(
      getAuthApplyNotice(
        status({
          state: 'failed',
          operation: { id: 'op', state: 'failed', errorCode: 'provider_failed', updatedAt: '' },
        })
      )
    ).toEqual({ kind: 'failed', errorCode: 'provider_failed' })
  })

  it('shows progress even when the Agent went offline mid-apply', () => {
    expect(
      getAuthApplyNotice(
        status({ state: 'applying', availability: { isAvailable: false, code: 'x', message: 'y' } })
      )
    ).toEqual({ kind: 'applying' })
  })
})
