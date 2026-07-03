import { describe, expect, it } from 'vitest'

import { parsePaginationParam } from './pagination'

describe('parsePaginationParam', () => {
  it.each([
    [undefined, 100, 100],
    ['0', 100, 0],
    ['25', 100, 25],
  ])('parses %s -> %s', (value, fallback, expected) => {
    expect(parsePaginationParam(value as any, fallback)).toBe(expected)
  })

  it.each([['abc'], ['-1'], ['1.5'], [['1', '2']]])('rejects %j', (value) => {
    expect(parsePaginationParam(value as any, 100)).toBeNull()
  })

  it('clamps limit above 1000 to 1000', () => {
    expect(parsePaginationParam('5000', 100)).toBe(1000)
    expect(parsePaginationParam('1000', 100)).toBe(1000)
    expect(parsePaginationParam('999', 100)).toBe(999)
  })
})
