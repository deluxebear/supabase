import { describe, expect, it } from 'vitest'

import { isTranslatableAttr, isTranslatableText } from './classify'

describe('isTranslatableText', () => {
  it('accepts normal sentences', () => {
    expect(isTranslatableText('Save changes')).toBe(true)
    expect(isTranslatableText('We could not find the page')).toBe(true)
  })
  it('rejects strings with no letters', () => {
    expect(isTranslatableText('123')).toBe(false)
    expect(isTranslatableText('  ')).toBe(false)
    expect(isTranslatableText('---')).toBe(false)
  })
  it('rejects ALL_CAPS constant-like tokens', () => {
    expect(isTranslatableText('SELECT_ALL')).toBe(false)
    expect(isTranslatableText('API_URL')).toBe(false)
  })
  it('rejects single lowercase identifier tokens (likely code)', () => {
    expect(isTranslatableText('className')).toBe(false)
    expect(isTranslatableText('createdAt')).toBe(false)
  })
  it('accepts a capitalized single word', () => {
    expect(isTranslatableText('Save')).toBe(true)
    expect(isTranslatableText('Cancel')).toBe(true)
  })
  it('rejects url/path-like strings', () => {
    expect(isTranslatableText('/project/[ref]/sql')).toBe(false)
    expect(isTranslatableText('https://supabase.com')).toBe(false)
  })
})

describe('isTranslatableAttr', () => {
  it('accepts known UI attributes', () => {
    for (const a of ['placeholder', 'title', 'label', 'aria-label', 'alt', 'description'])
      expect(isTranslatableAttr(a)).toBe(true)
  })
  it('rejects structural attributes', () => {
    for (const a of ['className', 'href', 'src', 'id', 'key', 'type', 'data-testid'])
      expect(isTranslatableAttr(a)).toBe(false)
  })
})
