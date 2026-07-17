import { describe, expect, it } from 'vitest'

import { isMonacoCancellation } from './configure-monaco-loader'

describe('isMonacoCancellation', () => {
  it('recognizes Monaco cancellation rejection shapes', () => {
    expect(isMonacoCancellation('Canceled')).toBe(true)
    expect(isMonacoCancellation(new Error('Canceled'))).toBe(true)
    expect(
      isMonacoCancellation({
        type: 'cancelation',
        msg: 'operation is manually canceled',
      })
    ).toBe(true)
  })

  it('does not suppress unrelated promise rejections', () => {
    expect(isMonacoCancellation(null)).toBe(false)
    expect(isMonacoCancellation(new Error('Something failed'))).toBe(false)
    expect(
      isMonacoCancellation({
        type: 'cancelation',
        msg: 'unrelated cancellation',
      })
    ).toBe(false)
    expect(
      isMonacoCancellation({
        type: 'error',
        msg: 'operation is manually canceled',
      })
    ).toBe(false)
  })
})
