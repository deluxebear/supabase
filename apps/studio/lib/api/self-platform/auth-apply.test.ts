import { describe, expect, it } from 'vitest'

import { deriveAuthApplyState, type AuthApplyOperation } from './auth-apply'

const operation = (state: string): AuthApplyOperation => ({
  id: 'auth_apply_1',
  state,
  errorCode: null,
  updatedAt: '2026-09-28T00:00:00Z',
})

describe('deriveAuthApplyState', () => {
  const planned = 'services:\n  auth:\n    environment: {}\n'

  it('reports nothing to apply before anything was stored or applied', () => {
    expect(
      deriveAuthApplyState({
        plannedContent: planned,
        hasOverrides: false,
        desiredContent: null,
        operation: null,
      })
    ).toBe('nothing-to-apply')
  })

  it('reports pending when stored settings differ from the desired revision', () => {
    expect(
      deriveAuthApplyState({
        plannedContent: planned,
        hasOverrides: true,
        desiredContent: null,
        operation: null,
      })
    ).toBe('pending')
    expect(
      deriveAuthApplyState({
        plannedContent: planned,
        hasOverrides: true,
        desiredContent: 'older',
        operation: operation('applied'),
      })
    ).toBe('pending')
  })

  it('reports cleared overrides as pending so they can be applied', () => {
    expect(
      deriveAuthApplyState({
        plannedContent: planned,
        hasOverrides: false,
        desiredContent: 'older',
        operation: null,
      })
    ).toBe('pending')
  })

  it('follows the operation for the current revision', () => {
    const base = { plannedContent: planned, hasOverrides: true, desiredContent: planned }
    expect(deriveAuthApplyState({ ...base, operation: operation('queued') })).toBe('applying')
    expect(deriveAuthApplyState({ ...base, operation: operation('applied') })).toBe('applied')
    expect(deriveAuthApplyState({ ...base, operation: operation('failed') })).toBe('failed')
    expect(deriveAuthApplyState({ ...base, operation: operation('superseded') })).toBe('pending')
    expect(deriveAuthApplyState({ ...base, operation: null })).toBe('pending')
  })
})
