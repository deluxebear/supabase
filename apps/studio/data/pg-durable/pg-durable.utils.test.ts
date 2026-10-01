import { describe, expect, it } from 'vitest'

import { compareDurableVersions, getDurableCapabilities } from './pg-durable.utils'

describe('getDurableCapabilities', () => {
  it.each([
    ['0.2.4', { multipart: false, transactionMode: false, loopContinueOnFailure: false }],
    ['0.2.5', { multipart: true, transactionMode: true, loopContinueOnFailure: false }],
    ['0.2.7', { multipart: true, transactionMode: true, loopContinueOnFailure: false }],
    ['0.2.8', { multipart: true, transactionMode: true, loopContinueOnFailure: true }],
    ['0.2.9-rc1', { multipart: true, transactionMode: true, loopContinueOnFailure: true }],
    [
      '0.2.8 (built 2026-09-11)',
      { multipart: true, transactionMode: true, loopContinueOnFailure: true },
    ],
    ['1.0.0', { multipart: true, transactionMode: true, loopContinueOnFailure: true }],
  ])('%s', (version, expected) => {
    expect(getDurableCapabilities(version)).toEqual(expected)
  })
  it.each([null, undefined, '', 'garbage'])('disables everything for %s', (version) => {
    expect(getDurableCapabilities(version)).toEqual({
      multipart: false,
      transactionMode: false,
      loopContinueOnFailure: false,
    })
  })
})

describe('compareDurableVersions', () => {
  it('orders numerically, not lexically', () => {
    expect(compareDurableVersions('0.2.10', '0.2.9')).toBeGreaterThan(0)
    expect(compareDurableVersions('0.2.4', '0.2.8')).toBeLessThan(0)
    expect(compareDurableVersions('0.2.8', '0.2.8')).toBe(0)
    expect(compareDurableVersions('x', '0.2.8')).toBeNull()
  })
})
