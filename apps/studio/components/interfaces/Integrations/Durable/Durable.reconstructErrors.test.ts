import { describe, expect, it, vi } from 'vitest'

import { translateReconstructError } from './Durable.reconstructErrors'

vi.mock('@/lib/i18n', () => ({
  t: (key: string, options?: Record<string, string>) =>
    `T:${key.replace(/\{\{(\w+)\}\}/g, (_, name) => options?.[name] ?? '')}`,
}))

describe('translateReconstructError', () => {
  it.each([
    ['Step n1 is missing', 'T:Step n1 is missing'],
    ['Step n1 is missing its else step', 'T:Step n1 is missing its T:else branch step'],
    ['The workflow graph contains a cycle', 'T:The workflow graph contains a cycle'],
    ['The workflow has no steps', 'T:The workflow has no steps'],
    ['Step a-b has no SQL', 'T:Step a-b has no SQL'],
    ['Step 7 has an invalid HTTP body', 'T:Step 7 has an invalid HTTP body'],
    ['Unsupported step type FOO', 'T:Unsupported step type FOO'],
  ])('translates %s', (reason, expected) => {
    expect(translateReconstructError(reason)).toBe(expected)
  })

  it('falls back to the raw reason for unknown messages', () => {
    expect(translateReconstructError('Something else broke')).toBe('Something else broke')
  })
})
