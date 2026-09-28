import { describe, expect, it } from 'vitest'

import { getConfigApplyNotice, type ConfigApplyNoticeStatus } from './ConfigApplyNotice.utils'

const status = (overrides: Partial<ConfigApplyNoticeStatus>): ConfigApplyNoticeStatus => ({
  availability: { isAvailable: true },
  state: 'pending',
  operation: null,
  ...overrides,
})

describe('getConfigApplyNotice', () => {
  it('falls back to the saved-only message without a status', () => {
    expect(getConfigApplyNotice(undefined)).toEqual({ kind: 'saved-only', reason: null })
  })

  it('hides the notice when the service already uses the stored settings', () => {
    expect(getConfigApplyNotice(status({ state: 'applied' }))).toEqual({ kind: 'hidden' })
    expect(getConfigApplyNotice(status({ state: 'nothing-to-apply' }))).toEqual({ kind: 'hidden' })
  })

  it('explains why applying is unavailable', () => {
    expect(
      getConfigApplyNotice(status({ availability: { isAvailable: false, message: 'No Agent' } }))
    ).toEqual({ kind: 'saved-only', reason: 'No Agent' })
  })

  it('offers to apply pending settings and reports progress and failures', () => {
    expect(getConfigApplyNotice(status({ state: 'pending' }))).toEqual({ kind: 'pending' })
    expect(getConfigApplyNotice(status({ state: 'applying' }))).toEqual({ kind: 'applying' })
    expect(
      getConfigApplyNotice(
        status({
          state: 'failed',
          operation: { errorCode: 'provider_failed' },
        })
      )
    ).toEqual({ kind: 'failed', errorCode: 'provider_failed' })
  })

  it('shows progress even when the Agent went offline mid-apply', () => {
    expect(
      getConfigApplyNotice(
        status({ state: 'applying', availability: { isAvailable: false, message: 'y' } })
      )
    ).toEqual({ kind: 'applying' })
  })
})
