export const TRANSLATABLE_ATTRS: ReadonlySet<string> = new Set([
  'placeholder',
  'title',
  'label',
  'aria-label',
  'aria-description',
  'alt',
  'description',
  'tooltip',
  'emptyText',
])

export const TOAST_METHODS: ReadonlySet<string> = new Set([
  'toast',
  'success',
  'error',
  'info',
  'warning',
  'message',
  'loading',
])

export function isTranslatableAttr(name: string): boolean {
  return TRANSLATABLE_ATTRS.has(name)
}

const HAS_LETTER = /\p{L}/u
const ALL_CAPS_CONST = /^[A-Z0-9_]+$/
const URL_OR_PATH = /^(https?:\/\/|\/|\.\/|\.\.\/|mailto:|tel:)/
// A single token with no spaces that looks like a code identifier.
const SINGLE_IDENT = /^[^\s]+$/
const CAMEL_OR_SNAKE = /^[a-z][a-zA-Z0-9]*$|_/

export function isTranslatableText(raw: string): boolean {
  const s = raw.trim()
  if (s.length === 0) return false
  if (!HAS_LETTER.test(s)) return false
  if (URL_OR_PATH.test(s)) return false
  if (ALL_CAPS_CONST.test(s)) return false
  // Single token, no whitespace: only accept if it reads like a Word (starts
  // uppercase, e.g. "Save", "Cancel"). Reject lowercase/camel/snake identifiers.
  if (SINGLE_IDENT.test(s) && !s.includes(' ')) {
    if (CAMEL_OR_SNAKE.test(s)) return false
    if (!/^[A-Z]/.test(s)) return false
  }
  return true
}
