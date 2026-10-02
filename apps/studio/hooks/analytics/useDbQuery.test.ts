import { describe, expect, it } from 'vitest'

import { canRunDbQuery } from './useDbQuery'

describe('canRunDbQuery', () => {
  it('runs immediately when self-hosted', () => {
    expect(canRunDbQuery({ isPlatform: false, isSelfPlatform: false })).toBe(true)
  })

  it('runs without a connection string on self-platform', () => {
    expect(canRunDbQuery({ isPlatform: true, isSelfPlatform: true, connectionString: '' })).toBe(
      true
    )
    expect(canRunDbQuery({ isPlatform: true, isSelfPlatform: true })).toBe(true)
  })

  it('waits for a connection string on hosted platform', () => {
    expect(canRunDbQuery({ isPlatform: true, isSelfPlatform: false })).toBe(false)
    expect(canRunDbQuery({ isPlatform: true, isSelfPlatform: false, connectionString: 'x' })).toBe(
      true
    )
  })
})
