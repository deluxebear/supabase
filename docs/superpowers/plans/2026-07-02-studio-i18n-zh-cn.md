# Studio zh-CN i18n Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add machine-translated Simplified Chinese (`zh-CN`) to all of Studio via a regenerable codemod, so translations survive upstream Supabase merges without ever being overwritten.

**Architecture:** `react-i18next` runtime with the English source string as the translation key. An idempotent `ts-morph` codemod wraps hardcoded UI strings in a global `t()`; the wrapped source is committed (2b). A machine-translation script produces the only fork-owned artifact, `zh-CN.json`. Upstream conflicts are resolved by taking upstream + re-running the codemod, so translations (living only in `zh-CN.json`) are structurally safe.

**Tech Stack:** React 19, Next.js pages router (behind a TanStack Router compat shim), `react-i18next` + `i18next`, `ts-morph`, `tsx`, Vitest, `sonner` (toasts).

## Global Constraints

- Target app: `apps/studio` only. Do not touch `apps/www`, `apps/docs`.
- Languages: English (implicit, = the key) + `zh-CN`. No RTL.
- **English string is the translation key.** Never invent key names.
- **No `en.json`.** `fallbackLng: 'en'` returns the key when a `zh-CN` entry is missing.
- The **only** committed catalog is `apps/studio/lib/i18n/locales/zh-CN.json`.
- Import alias: `@/*` → `apps/studio/*` (so `@/lib/i18n` = `apps/studio/lib/i18n/index.ts`).
- The codemod must be **idempotent** (safe to re-run after every upstream merge).
- Translation is **machine only**, shipped as-is; the translate step is **incremental** (only missing keys).
- UI copy: U.S. English source strings; Tailwind + semantic tokens for any new UI.
- Run unit tests with `pnpm --filter studio test`. Run scripts with `pnpm --filter studio exec tsx <path>`.
- Add deps with `pnpm --filter studio add <pkg>` / `pnpm --filter studio add -D <pkg>`.

---

### Task 1: i18n runtime core (`lib/i18n`)

Creates the i18next instance, the global bound `t`, locale persistence, and the `zh-CN` catalog seed. This is what the codemod's injected `import { t } from '@/lib/i18n'` resolves to.

**Files:**

- Modify: `apps/studio/package.json` (add `i18next`, `react-i18next`)
- Create: `apps/studio/lib/i18n/locales/zh-CN.json`
- Create: `apps/studio/lib/i18n/index.ts`
- Test: `apps/studio/lib/i18n/index.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `t(key: string, vars?: Record<string, unknown>): string` — global bound translator.
  - `i18n` — the configured `i18next` instance (default export of the module namespace).
  - `LOCALES: readonly ['en', 'zh-CN']`, `type Locale = 'en' | 'zh-CN'`, `DEFAULT_LOCALE: 'en'`, `LOCALE_STORAGE_KEY: 'studio.locale'`.
  - `getInitialLocale(): Locale`, `applyLocale(locale: Locale): void` (calls `i18n.changeLanguage` + persists to `localStorage`).

- [ ] **Step 1: Add dependencies**

Run: `pnpm --filter studio add i18next react-i18next`
Expected: `package.json` gains both under `dependencies`; install succeeds.

- [ ] **Step 2: Create the seed catalog**

Create `apps/studio/lib/i18n/locales/zh-CN.json` with an empty object:

```json
{}
```

- [ ] **Step 3: Write the failing test**

Create `apps/studio/lib/i18n/index.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'

import { applyLocale, getInitialLocale, i18n, LOCALE_STORAGE_KEY, t } from './index'

describe('i18n core', () => {
  beforeEach(async () => {
    localStorage.clear()
    await i18n.changeLanguage('en')
  })

  it('falls back to the English key when no translation exists', () => {
    expect(t('Save changes')).toBe('Save changes')
  })

  it('returns the zh-CN value after switching locale', async () => {
    i18n.addResource('zh-CN', 'translation', 'Save changes', '保存更改')
    await applyLocale('zh-CN')
    expect(t('Save changes')).toBe('保存更改')
  })

  it('interpolates variables with the {{var}} syntax', async () => {
    i18n.addResource('zh-CN', 'translation', 'Hello {{name}}', '你好 {{name}}')
    await applyLocale('zh-CN')
    expect(t('Hello {{name}}', { name: 'Ann' })).toBe('你好 Ann')
  })

  it('persists the chosen locale to localStorage', async () => {
    await applyLocale('zh-CN')
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe('zh-CN')
    expect(getInitialLocale()).toBe('zh-CN')
  })

  it('defaults to en when nothing is stored', () => {
    expect(getInitialLocale()).toBe('en')
  })
})
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `pnpm --filter studio test -- lib/i18n/index.test.ts`
Expected: FAIL — `Cannot find module './index'`.

- [ ] **Step 5: Implement the core**

Create `apps/studio/lib/i18n/index.ts`:

```ts
import i18next from 'i18next'
import { initReactI18next } from 'react-i18next'

import zhCN from './locales/zh-CN.json'

export const LOCALES = ['en', 'zh-CN'] as const
export type Locale = (typeof LOCALES)[number]
export const DEFAULT_LOCALE: Locale = 'en'
export const LOCALE_STORAGE_KEY = 'studio.locale'

export const i18n = i18next.createInstance()

// Synchronous init: resources are bundled, so `t` is usable immediately and
// `changeLanguage` resolves without a network round-trip.
i18n.use(initReactI18next).init({
  lng: DEFAULT_LOCALE,
  fallbackLng: 'en',
  resources: {
    'zh-CN': { translation: zhCN as Record<string, string> },
  },
  // The key IS the English source string — disable key namespacing/nesting so
  // strings like "a.b" or "Save: now" are treated as literal keys.
  keySeparator: false,
  nsSeparator: false,
  interpolation: { escapeValue: false },
  returnNull: false,
})

export const t = i18n.t.bind(i18n) as (key: string, vars?: Record<string, unknown>) => string

function isLocale(value: string | null): value is Locale {
  return value !== null && (LOCALES as readonly string[]).includes(value)
}

export function getInitialLocale(): Locale {
  if (typeof window === 'undefined') return DEFAULT_LOCALE
  const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY)
  if (isLocale(stored)) return stored
  const browser = window.navigator.language
  if (browser && browser.toLowerCase().startsWith('zh')) return 'zh-CN'
  return DEFAULT_LOCALE
}

export async function applyLocale(locale: Locale): Promise<void> {
  await i18n.changeLanguage(locale)
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter studio test -- lib/i18n/index.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Commit**

```bash
git add apps/studio/package.json apps/studio/lib/i18n/ ../../pnpm-lock.yaml
git commit -m "feat(studio): add react-i18next runtime core for zh-CN"
```

---

### Task 2: `I18nProvider` + locale context

Wraps the app so switching locale re-renders the tree (the global `t` re-reads on remount). Wires into `_app.tsx` — the single meaningful edit to an upstream-tracked file.

**Files:**

- Create: `apps/studio/lib/i18n/I18nProvider.tsx`
- Modify: `apps/studio/pages/_app.tsx` (add provider to the stack)
- Test: `apps/studio/lib/i18n/I18nProvider.test.tsx`

**Interfaces:**

- Consumes: `getInitialLocale`, `applyLocale`, `Locale` from `./index` (Task 1).
- Produces:
  - `I18nProvider({ children }: { children: ReactNode }): JSX.Element`
  - `useLocale(): { locale: Locale; setLocale: (l: Locale) => void }`

- [ ] **Step 1: Write the failing test**

Create `apps/studio/lib/i18n/I18nProvider.test.tsx`:

```tsx
import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { I18nProvider, useLocale } from './I18nProvider'
import { i18n } from './index'

function Probe() {
  const { locale, setLocale } = useLocale()
  return (
    <button onClick={() => setLocale('zh-CN')} data-testid="btn">
      {locale}
    </button>
  )
}

describe('I18nProvider', () => {
  beforeEach(async () => {
    localStorage.clear()
    await i18n.changeLanguage('en')
  })

  it('provides the current locale and updates it on setLocale', async () => {
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>
    )
    expect(screen.getByTestId('btn').textContent).toBe('en')
    await act(async () => {
      screen.getByTestId('btn').click()
    })
    expect(screen.getByTestId('btn').textContent).toBe('zh-CN')
    expect(i18n.language).toBe('zh-CN')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter studio test -- lib/i18n/I18nProvider.test.tsx`
Expected: FAIL — `Cannot find module './I18nProvider'`.

- [ ] **Step 3: Implement the provider**

Create `apps/studio/lib/i18n/I18nProvider.tsx`:

```tsx
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'

import { applyLocale, getInitialLocale, i18n, type Locale } from './index'

interface LocaleContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
}

const LocaleContext = createContext<LocaleContextValue | null>(null)

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext)
  if (!ctx) throw new Error('useLocale must be used within an I18nProvider')
  return ctx
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('en')

  // Resolve the persisted/browser locale on the client after mount to avoid
  // SSR hydration mismatches (server always renders `en`).
  useEffect(() => {
    const initial = getInitialLocale()
    if (initial !== 'en') void applyLocale(initial).then(() => setLocaleState(initial))
  }, [])

  const setLocale = useCallback((next: Locale) => {
    void applyLocale(next).then(() => setLocaleState(next))
  }, [])

  return (
    <LocaleContext.Provider value={{ locale, setLocale }}>
      {/* Remount the tree on locale change so the global `t` re-reads.
          Language switches are rare, so a full remount is acceptable. */}
      <div key={locale} style={{ display: 'contents' }}>
        {children}
      </div>
    </LocaleContext.Provider>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter studio test -- lib/i18n/I18nProvider.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wire into `_app.tsx`**

Open `apps/studio/pages/_app.tsx`. Add the import near the other `@/lib` imports:

```tsx
import { I18nProvider } from '@/lib/i18n/I18nProvider'
```

Wrap the existing provider stack. Find the outermost app provider inside `QueryClientProvider` (the `AuthProvider`/`FeatureFlagProvider` block around line 176) and place `I18nProvider` just inside `QueryClientProvider` so the whole app remounts on locale change but the React Query cache (held above) is preserved:

```tsx
<QueryClientProvider client={queryClient}>
  <I18nProvider>
    {/* ...existing HydrationBoundary / AuthProvider / ... stack unchanged... */}
  </I18nProvider>
</QueryClientProvider>
```

- [ ] **Step 6: Verify typecheck + build of the touched file**

Run: `pnpm --filter studio exec tsc --noEmit -p tsconfig.json`
Expected: no new type errors from `_app.tsx` or the i18n files.

- [ ] **Step 7: Commit**

```bash
git add apps/studio/lib/i18n/I18nProvider.tsx apps/studio/pages/_app.tsx
git commit -m "feat(studio): mount I18nProvider in app provider stack"
```

---

### Task 3: Language switcher UI

A small selector that calls `setLocale`, defaulting to the account menu area.

**Files:**

- Create: `apps/studio/components/ui/LanguageSwitcher.tsx`
- Test: `apps/studio/components/ui/LanguageSwitcher.test.tsx`

**Interfaces:**

- Consumes: `useLocale` (Task 2), `LOCALES`, `type Locale` (Task 1); UI primitives from `'ui'`.
- Produces: `LanguageSwitcher(): JSX.Element`.

- [ ] **Step 1: Write the failing test**

Create `apps/studio/components/ui/LanguageSwitcher.test.tsx`:

```tsx
import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { LanguageSwitcher } from './LanguageSwitcher'
import { i18n } from '@/lib/i18n'
import { I18nProvider } from '@/lib/i18n/I18nProvider'

describe('LanguageSwitcher', () => {
  beforeEach(async () => {
    localStorage.clear()
    await i18n.changeLanguage('en')
  })

  it('switches the locale to zh-CN when selected', async () => {
    render(
      <I18nProvider>
        <LanguageSwitcher />
      </I18nProvider>
    )
    const select = screen.getByLabelText('Language') as HTMLSelectElement
    expect(select.value).toBe('en')
    await act(async () => {
      select.value = 'zh-CN'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(i18n.language).toBe('zh-CN')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter studio test -- components/ui/LanguageSwitcher.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the switcher**

Create `apps/studio/components/ui/LanguageSwitcher.tsx`. Keep it a native `<select>` to avoid coupling to a specific dropdown primitive; label uses a semantic token.

```tsx
import { LOCALES, type Locale } from '@/lib/i18n'
import { useLocale } from '@/lib/i18n/I18nProvider'

const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  'zh-CN': '简体中文',
}

export function LanguageSwitcher() {
  const { locale, setLocale } = useLocale()
  return (
    <label className="flex items-center gap-2 text-sm text-foreground-light">
      <span>Language</span>
      <select
        aria-label="Language"
        className="bg-transparent text-foreground"
        value={locale}
        onChange={(e) => setLocale(e.target.value as Locale)}
      >
        {LOCALES.map((l) => (
          <option key={l} value={l}>
            {LOCALE_LABELS[l]}
          </option>
        ))}
      </select>
    </label>
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter studio test -- components/ui/LanguageSwitcher.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/studio/components/ui/LanguageSwitcher.tsx apps/studio/components/ui/LanguageSwitcher.test.tsx
git commit -m "feat(studio): add LanguageSwitcher control"
```

> Placement into the account dropdown is deferred to Task 9 (after the sweep) to keep this task's diff isolated and reviewable.

---

### Task 4: Codemod string classification (`scripts/i18n/classify.ts`)

Pure predicates that decide whether a given string is user-facing UI text. Isolated and heavily unit-tested because this is where over/under-wrapping risk lives.

**Files:**

- Modify: `apps/studio/package.json` (add `ts-morph` dev dep)
- Create: `apps/studio/scripts/i18n/classify.ts`
- Test: `apps/studio/scripts/i18n/classify.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `TRANSLATABLE_ATTRS: ReadonlySet<string>` — attribute names whose string values are UI text.
  - `TOAST_METHODS: ReadonlySet<string>` — `sonner` toast methods whose first string arg is UI text.
  - `isTranslatableText(raw: string): boolean` — for JSX text nodes / attribute values.
  - `isTranslatableAttr(name: string): boolean`.

- [ ] **Step 1: Add ts-morph**

Run: `pnpm --filter studio add -D ts-morph`
Expected: `ts-morph` under `devDependencies`.

- [ ] **Step 2: Write the failing test**

Create `apps/studio/scripts/i18n/classify.test.ts`:

```ts
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm --filter studio test -- scripts/i18n/classify.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the classifier**

Create `apps/studio/scripts/i18n/classify.ts`:

```ts
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
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter studio test -- scripts/i18n/classify.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/studio/package.json apps/studio/scripts/i18n/classify.ts apps/studio/scripts/i18n/classify.test.ts ../../pnpm-lock.yaml
git commit -m "feat(studio): add i18n codemod string classifier"
```

---

### Task 5: Codemod transform (`scripts/i18n/transform.ts`)

Given one `ts-morph` `SourceFile`, wrap translatable strings and collect keys. Idempotent. Unit-tested against in-memory source fixtures.

**Files:**

- Create: `apps/studio/scripts/i18n/transform.ts`
- Test: `apps/studio/scripts/i18n/transform.test.ts`

**Interfaces:**

- Consumes: `isTranslatableText`, `isTranslatableAttr`, `TOAST_METHODS` (Task 4); `Project`, `SourceFile` from `ts-morph`.
- Produces:
  - `transformSourceFile(sf: SourceFile): { keys: string[]; changed: boolean }` — mutates `sf` in place, returns collected English keys and whether anything changed.

- [ ] **Step 1: Write the failing test**

Create `apps/studio/scripts/i18n/transform.test.ts`:

```ts
import { Project } from 'ts-morph'
import { describe, expect, it } from 'vitest'

import { transformSourceFile } from './transform'

function run(source: string) {
  const project = new Project({ useInMemoryFileSystem: true })
  const sf = project.createSourceFile('C.tsx', source)
  const { keys } = transformSourceFile(sf)
  return { text: sf.getFullText(), keys }
}

describe('transformSourceFile', () => {
  it('wraps a JSX text node with t() and imports it', () => {
    const { text, keys } = run(`export const C = () => <div>Save changes</div>`)
    expect(text).toContain(`import { t } from '@/lib/i18n'`)
    expect(text).toContain(`<div>{t('Save changes')}</div>`)
    expect(keys).toContain('Save changes')
  })

  it('wraps an allowlisted attribute', () => {
    const { text } = run(`export const C = () => <input placeholder="Search tables" />`)
    expect(text).toContain(`placeholder={t('Search tables')}`)
  })

  it('leaves structural attributes alone', () => {
    const { text } = run(`export const C = () => <div className="Save changes" />`)
    expect(text).toContain(`className="Save changes"`)
    expect(text).not.toContain('t(')
  })

  it('wraps a sonner toast string argument', () => {
    const src = `import { toast } from 'sonner'\nexport const f = () => toast.success('Saved successfully')`
    const { text } = run(src)
    expect(text).toContain(`toast.success(t('Saved successfully'))`)
  })

  it('is idempotent — a second pass makes no changes', () => {
    const once = run(`export const C = () => <div>Hello there</div>`).text
    const project = new Project({ useInMemoryFileSystem: true })
    const sf = project.createSourceFile('C.tsx', once)
    const { changed } = transformSourceFile(sf)
    expect(changed).toBe(false)
    expect(sf.getFullText()).toBe(once)
  })

  it('does not wrap non-translatable text', () => {
    const { text, keys } = run(`export const C = () => <div>{count}</div>`)
    expect(keys).toEqual([])
    expect(text).not.toContain('t(')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter studio test -- scripts/i18n/transform.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the transform**

Create `apps/studio/scripts/i18n/transform.ts`:

```ts
import { Node, SyntaxKind, type SourceFile } from 'ts-morph'

import { isTranslatableAttr, isTranslatableText, TOAST_METHODS } from './classify'

const I18N_IMPORT = '@/lib/i18n'

// Turn an English source string into a valid single-quoted t() call, escaping
// backslashes and single quotes.
function tCall(key: string): string {
  const escaped = key.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
  return `t('${escaped}')`
}

function ensureImport(sf: SourceFile): void {
  const existing = sf.getImportDeclaration((d) => d.getModuleSpecifierValue() === I18N_IMPORT)
  if (existing) {
    if (!existing.getNamedImports().some((n) => n.getName() === 't')) {
      existing.addNamedImport('t')
    }
    return
  }
  sf.insertImportDeclaration(0, { moduleSpecifier: I18N_IMPORT, namedImports: ['t'] })
}

export function transformSourceFile(sf: SourceFile): { keys: string[]; changed: boolean } {
  const keys: string[] = []
  let changed = false

  const record = (key: string) => {
    keys.push(key)
    changed = true
  }

  // 1) JSX text nodes: <div>Save changes</div>
  sf.forEachDescendant((node) => {
    if (Node.isJsxText(node)) {
      const raw = node.getLiteralText()
      const trimmed = raw.trim()
      if (!isTranslatableText(trimmed)) return
      // Preserve surrounding whitespace around the wrapped expression.
      const leading = raw.slice(0, raw.indexOf(trimmed))
      const trailing = raw.slice(raw.indexOf(trimmed) + trimmed.length)
      node.replaceWithText(`${leading}{${tCall(trimmed)}}${trailing}`)
      record(trimmed)
    }
  })

  // 2) JSX attributes: placeholder="Search tables"
  sf.forEachDescendant((node) => {
    if (Node.isJsxAttribute(node)) {
      const name = node.getNameNode().getText()
      if (!isTranslatableAttr(name)) return
      const init = node.getInitializer()
      if (init && Node.isStringLiteral(init)) {
        const value = init.getLiteralValue()
        if (!isTranslatableText(value)) return
        init.replaceWithText(`{${tCall(value)}}`)
        record(value)
      }
    }
  })

  // 3) sonner toast calls: toast.success('Saved successfully')
  sf.forEachDescendant((node) => {
    if (!Node.isCallExpression(node)) return
    const expr = node.getExpression()
    let method: string | undefined
    if (Node.isPropertyAccessExpression(expr) && expr.getExpression().getText() === 'toast') {
      method = expr.getName()
    } else if (Node.isIdentifier(expr) && expr.getText() === 'toast') {
      method = 'toast'
    }
    if (!method || !TOAST_METHODS.has(method)) return
    const arg = node.getArguments()[0]
    if (arg && Node.isStringLiteral(arg)) {
      const value = arg.getLiteralValue()
      if (!isTranslatableText(value)) return
      arg.replaceWithText(tCall(value))
      record(value)
    }
  })

  if (changed) ensureImport(sf)
  return { keys, changed }
}
```

> Note on idempotency: an already-wrapped string lives inside a `{t('...')}`
> expression, so its text is no longer a `JsxText`/plain `StringLiteral` in a
> translatable position — the predicates skip it and `changed` stays `false`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter studio test -- scripts/i18n/transform.test.ts`
Expected: PASS (6 tests). If the idempotency test fails, inspect which node was re-wrapped and tighten the guard.

- [ ] **Step 5: Commit**

```bash
git add apps/studio/scripts/i18n/transform.ts apps/studio/scripts/i18n/transform.test.ts
git commit -m "feat(studio): add idempotent i18n wrapping transform"
```

---

### Task 6: Codemod CLI runner (`scripts/i18n/wrap.ts`)

Walks Studio source, applies `transformSourceFile`, writes files, and emits a report + the full key list.

**Files:**

- Create: `apps/studio/scripts/i18n/wrap.ts`
- Test: `apps/studio/scripts/i18n/wrap.test.ts`

**Interfaces:**

- Consumes: `transformSourceFile` (Task 5); `Project` from `ts-morph`.
- Produces:
  - `wrapProject(opts: { tsConfigFilePath: string; globs: string[]; dryRun?: boolean }): { filesChanged: number; keys: string[] }`
  - CLI entry (`tsx wrap.ts`) that writes changed files and dumps `scripts/i18n/keys.json` + prints a summary.

- [ ] **Step 1: Write the failing test**

Create `apps/studio/scripts/i18n/wrap.test.ts`:

```ts
import { Project } from 'ts-morph'
import { describe, expect, it } from 'vitest'

import { collectFromProject } from './wrap'

describe('collectFromProject', () => {
  it('aggregates keys across multiple in-memory files', () => {
    const project = new Project({ useInMemoryFileSystem: true })
    project.createSourceFile('a.tsx', `export const A = () => <div>Alpha label</div>`)
    project.createSourceFile('b.tsx', `export const B = () => <div>Beta label</div>`)
    const { filesChanged, keys } = collectFromProject(project)
    expect(filesChanged).toBe(2)
    expect(keys.sort()).toEqual(['Alpha label', 'Beta label'])
  })

  it('reports zero changes on already-wrapped source', () => {
    const project = new Project({ useInMemoryFileSystem: true })
    project.createSourceFile(
      'a.tsx',
      `import { t } from '@/lib/i18n'\nexport const A = () => <div>{t('Alpha label')}</div>`
    )
    const { filesChanged } = collectFromProject(project)
    expect(filesChanged).toBe(0)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter studio test -- scripts/i18n/wrap.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the runner**

Create `apps/studio/scripts/i18n/wrap.ts`:

```ts
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Project } from 'ts-morph'

import { transformSourceFile } from './transform'

export function collectFromProject(project: Project): { filesChanged: number; keys: string[] } {
  const keys = new Set<string>()
  let filesChanged = 0
  for (const sf of project.getSourceFiles()) {
    const { keys: fileKeys, changed } = transformSourceFile(sf)
    if (changed) filesChanged++
    for (const k of fileKeys) keys.add(k)
  }
  return { filesChanged, keys: [...keys] }
}

export function wrapProject(opts: {
  tsConfigFilePath: string
  globs: string[]
  dryRun?: boolean
}): { filesChanged: number; keys: string[] } {
  const project = new Project({ tsConfigFilePath: opts.tsConfigFilePath })
  project.addSourceFilesAtPaths(opts.globs)
  const result = collectFromProject(project)
  if (!opts.dryRun) project.saveSync()
  return result
}

// CLI: pnpm --filter studio exec tsx scripts/i18n/wrap.ts [--dry]
if (process.argv[1] && process.argv[1].endsWith('wrap.ts')) {
  const dryRun = process.argv.includes('--dry')
  const cwd = process.cwd() // apps/studio
  const { filesChanged, keys } = wrapProject({
    tsConfigFilePath: join(cwd, 'tsconfig.json'),
    globs: [join(cwd, 'components/**/*.tsx'), join(cwd, 'pages/**/*.tsx')],
    dryRun,
  })
  writeFileSync(join(cwd, 'scripts/i18n/keys.json'), JSON.stringify(keys.sort(), null, 2) + '\n')
  console.log(
    `i18n wrap: ${filesChanged} files changed, ${keys.length} unique keys` +
      (dryRun ? ' (dry run, nothing written)' : '')
  )
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter studio test -- scripts/i18n/wrap.test.ts`
Expected: PASS.

- [ ] **Step 5: Dry-run the CLI against real source (no writes)**

Run: `cd apps/studio && pnpm exec tsx scripts/i18n/wrap.ts --dry`
Expected: prints a non-zero `files changed` / `unique keys` count and writes `scripts/i18n/keys.json`. Spot-check `keys.json` for obvious false positives (code identifiers, class names). If many appear, tighten `classify.ts` and re-run before proceeding.

- [ ] **Step 6: Commit**

```bash
git add apps/studio/scripts/i18n/wrap.ts apps/studio/scripts/i18n/wrap.test.ts apps/studio/scripts/i18n/keys.json
git commit -m "feat(studio): add i18n codemod CLI runner"
```

---

### Task 7: Machine translation script (`scripts/i18n/translate.ts`)

Diffs keys against `zh-CN.json` and translates only the missing ones via a swappable engine. Incremental so upstream syncs are cheap.

**Files:**

- Create: `apps/studio/scripts/i18n/engine.ts`
- Create: `apps/studio/scripts/i18n/translate.ts`
- Test: `apps/studio/scripts/i18n/translate.test.ts`

**Interfaces:**

- Consumes: `keys.json` (Task 6), `lib/i18n/locales/zh-CN.json` (Task 1).
- Produces:
  - `interface TranslationEngine { translate(keys: string[]): Promise<Record<string, string>> }`
  - `mergeTranslations(keys: string[], existing: Record<string,string>, engine: TranslationEngine): Promise<Record<string,string>>` — returns existing + newly translated missing keys, untouched keys preserved.
  - `createDefaultEngine(): TranslationEngine` — reads `I18N_TRANSLATE_ENDPOINT`, `I18N_TRANSLATE_API_KEY`, `I18N_TRANSLATE_MODEL` and calls an LLM; batches keys.

- [ ] **Step 1: Write the failing test**

Create `apps/studio/scripts/i18n/translate.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'

import { mergeTranslations, type TranslationEngine } from './translate'

const fakeEngine: TranslationEngine = {
  translate: vi.fn(async (keys: string[]) => Object.fromEntries(keys.map((k) => [k, `译:${k}`]))),
}

describe('mergeTranslations', () => {
  it('only translates keys missing from the existing catalog', async () => {
    const existing = { 'Save changes': '保存更改' }
    const keys = ['Save changes', 'Cancel']
    const result = await mergeTranslations(keys, existing, fakeEngine)
    expect(result['Save changes']).toBe('保存更改') // preserved
    expect(result['Cancel']).toBe('译:Cancel') // newly translated
    expect(fakeEngine.translate).toHaveBeenCalledWith(['Cancel'])
  })

  it('preserves existing translations for keys no longer present (no deletion)', async () => {
    const existing = { 'Old string': '旧' }
    const result = await mergeTranslations(['New string'], existing, fakeEngine)
    expect(result['Old string']).toBe('旧')
    expect(result['New string']).toBe('译:New string')
  })

  it('does not call the engine when nothing is missing', async () => {
    const engine: TranslationEngine = { translate: vi.fn(async () => ({})) }
    const result = await mergeTranslations(['A'], { A: '甲' }, engine)
    expect(engine.translate).not.toHaveBeenCalled()
    expect(result).toEqual({ A: '甲' })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter studio test -- scripts/i18n/translate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the engine**

Create `apps/studio/scripts/i18n/engine.ts`:

```ts
import type { TranslationEngine } from './translate'

// Default engine: calls an OpenAI-compatible chat-completions endpoint and asks
// for a strict JSON map of English -> Simplified Chinese. Configurable so it can
// be swapped for any provider without touching call sites.
export function createDefaultEngine(): TranslationEngine {
  const endpoint = process.env.I18N_TRANSLATE_ENDPOINT
  const apiKey = process.env.I18N_TRANSLATE_API_KEY
  const model = process.env.I18N_TRANSLATE_MODEL ?? 'gpt-4o-mini'
  const batchSize = Number(process.env.I18N_TRANSLATE_BATCH ?? '50')

  if (!endpoint || !apiKey) {
    throw new Error(
      'Set I18N_TRANSLATE_ENDPOINT and I18N_TRANSLATE_API_KEY (and optionally I18N_TRANSLATE_MODEL) to run machine translation.'
    )
  }

  async function translateBatch(keys: string[]): Promise<Record<string, string>> {
    const prompt =
      'Translate each English UI string to Simplified Chinese (zh-CN). ' +
      'Preserve {{placeholders}} verbatim. Return ONLY a JSON object mapping ' +
      'each original English string to its translation.\n\n' +
      JSON.stringify(keys)
    const res = await fetch(endpoint!, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0,
      }),
    })
    if (!res.ok) throw new Error(`Translate API ${res.status}: ${await res.text()}`)
    const data = await res.json()
    const content = data.choices?.[0]?.message?.content ?? '{}'
    return JSON.parse(content) as Record<string, string>
  }

  return {
    async translate(keys: string[]): Promise<Record<string, string>> {
      const out: Record<string, string> = {}
      for (let i = 0; i < keys.length; i += batchSize) {
        Object.assign(out, await translateBatch(keys.slice(i, i + batchSize)))
      }
      return out
    },
  }
}
```

- [ ] **Step 4: Implement the merge + CLI**

Create `apps/studio/scripts/i18n/translate.ts`:

```ts
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface TranslationEngine {
  translate(keys: string[]): Promise<Record<string, string>>
}

export async function mergeTranslations(
  keys: string[],
  existing: Record<string, string>,
  engine: TranslationEngine
): Promise<Record<string, string>> {
  const missing = keys.filter((k) => !(k in existing))
  if (missing.length === 0) return { ...existing }
  const translated = await engine.translate(missing)
  return { ...existing, ...translated }
}

// CLI: pnpm --filter studio exec tsx scripts/i18n/translate.ts
if (process.argv[1] && process.argv[1].endsWith('translate.ts')) {
  const cwd = process.cwd() // apps/studio
  const keysPath = join(cwd, 'scripts/i18n/keys.json')
  const catalogPath = join(cwd, 'lib/i18n/locales/zh-CN.json')
  const keys = JSON.parse(readFileSync(keysPath, 'utf8')) as string[]
  const existing = JSON.parse(readFileSync(catalogPath, 'utf8')) as Record<string, string>

  // Lazy import so unit tests never touch the network-backed engine.
  const { createDefaultEngine } = await import('./engine')
  const merged = await mergeTranslations(keys, existing, createDefaultEngine())

  // Stable key order for clean diffs.
  const sorted = Object.fromEntries(
    Object.keys(merged)
      .sort()
      .map((k) => [k, merged[k]])
  )
  writeFileSync(catalogPath, JSON.stringify(sorted, null, 2) + '\n')
  const added = keys.filter((k) => !(k in existing)).length
  console.log(`i18n translate: ${added} new keys translated, ${Object.keys(sorted).length} total`)
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter studio test -- scripts/i18n/translate.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add apps/studio/scripts/i18n/engine.ts apps/studio/scripts/i18n/translate.ts apps/studio/scripts/i18n/translate.test.ts
git commit -m "feat(studio): add incremental machine-translation script"
```

---

### Task 8: Run the full sweep + verify build

Executes the codemod over all of Studio, commits the wrapped source, and confirms the app still typechecks and builds. No new code — this is the big mechanical transform with a verification gate.

**Files:**

- Modify: `apps/studio/components/**/*.tsx`, `apps/studio/pages/**/*.tsx` (generated)
- Modify: `apps/studio/scripts/i18n/keys.json` (generated)

- [ ] **Step 1: Run the codemod for real**

Run: `cd apps/studio && pnpm exec tsx scripts/i18n/wrap.ts`
Expected: prints `<N> files changed, <M> unique keys`; source files rewritten; `keys.json` populated.

- [ ] **Step 2: Lint-fix formatting on the transform**

Run: `pnpm --filter studio exec prettier --write "components/**/*.tsx" "pages/**/*.tsx"`
Expected: formatting normalized (the codemod's inserted imports/expressions get reformatted to house style).

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter studio exec tsc --noEmit -p tsconfig.json`
Expected: PASS. If failures appear, they are almost always a malformed wrap (e.g., a string that contained a quote). Fix `transform.ts` escaping, `git checkout -- components pages`, and re-run from Step 1 — do NOT hand-edit generated output.

- [ ] **Step 4: Run the unit test suite**

Run: `pnpm --filter studio test`
Expected: PASS (no regressions from wrapped strings).

- [ ] **Step 5: Production build**

Run: `pnpm build --filter=studio`
Expected: build succeeds.

- [ ] **Step 6: Commit the sweep**

```bash
git add apps/studio/components apps/studio/pages apps/studio/scripts/i18n/keys.json
git commit -m "feat(studio): wrap UI strings for i18n (codemod sweep)"
```

---

### Task 9: Generate translations + place the switcher + smoke test

Produces `zh-CN.json`, mounts the switcher, and verifies a real screen renders Chinese.

**Files:**

- Modify: `apps/studio/lib/i18n/locales/zh-CN.json` (generated)
- Modify: the account dropdown menu component (add `<LanguageSwitcher />`)

- [ ] **Step 1: Configure the translation engine**

Set env for the chosen provider, e.g.:

```bash
export I18N_TRANSLATE_ENDPOINT="https://api.openai.com/v1/chat/completions"
export I18N_TRANSLATE_API_KEY="sk-..."
export I18N_TRANSLATE_MODEL="gpt-4o-mini"
```

- [ ] **Step 2: Run the translation**

Run: `cd apps/studio && pnpm exec tsx scripts/i18n/translate.ts`
Expected: prints `<N> new keys translated, <M> total`; `lib/i18n/locales/zh-CN.json` populated with sorted keys.

- [ ] **Step 3: Place the switcher in the account menu**

Locate the account dropdown (search: `grep -rn "Account preferences\|Sign out\|DropdownMenu" apps/studio/components/interfaces/Account apps/studio/components/layouts | head`). Add `<LanguageSwitcher />` as a menu row near "Account preferences", importing:

```tsx
import { LanguageSwitcher } from '@/components/ui/LanguageSwitcher'
```

- [ ] **Step 4: Smoke-test locale switching in the dev server**

Run: `pnpm dev:studio`, open the app, switch language to 简体中文 via the switcher, and confirm a known screen (e.g. the 404 page text or the account menu) renders Chinese, and that an untranslated string falls back to English.

- [ ] **Step 5: Commit**

```bash
git add apps/studio/lib/i18n/locales/zh-CN.json apps/studio/components
git commit -m "feat(studio): generate zh-CN translations and expose language switcher"
```

---

### Task 10: Upstream-sync tooling + docs

Locks in the merge-safe workflow: a sync script, an optional git merge driver, and documentation.

**Files:**

- Create: `apps/studio/scripts/i18n/sync-upstream.sh`
- Create: `apps/studio/scripts/i18n/merge-driver.sh`
- Modify: `.gitattributes` (repo root)
- Create: `apps/studio/scripts/i18n/README.md`
- Test: `apps/studio/scripts/i18n/sync-upstream.test.ts`

**Interfaces:**

- Consumes: `wrap.ts`, `translate.ts` (Tasks 6–7).
- Produces: `sync-upstream.sh` (idempotent re-wrap + re-translate), a merge driver, and a documented process.

- [ ] **Step 1: Write a sync-regeneration integration test**

Create `apps/studio/scripts/i18n/sync-upstream.test.ts` — proves the "new upstream string" path wraps + preserves existing translations:

```ts
import { Project } from 'ts-morph'
import { describe, expect, it } from 'vitest'

import { mergeTranslations, type TranslationEngine } from './translate'
import { collectFromProject } from './wrap'

const engine: TranslationEngine = {
  translate: async (keys) => Object.fromEntries(keys.map((k) => [k, `zh:${k}`])),
}

describe('upstream sync regeneration', () => {
  it('wraps a newly added upstream string and keeps existing translations', async () => {
    // Simulate post-merge source: one already-wrapped string + one new upstream string.
    const project = new Project({ useInMemoryFileSystem: true })
    project.createSourceFile(
      'C.tsx',
      `import { t } from '@/lib/i18n'\n` +
        `export const C = () => <div>{t('Existing')}<span>Brand new</span></div>`
    )
    const { keys } = collectFromProject(project)
    expect(keys).toContain('Brand new')

    const existing = { Existing: '已存在' }
    const merged = await mergeTranslations([...keys, 'Existing'], existing, engine)
    expect(merged['Existing']).toBe('已存在') // preserved, not overwritten
    expect(merged['Brand new']).toBe('zh:Brand new') // newly translated
  })
})
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `pnpm --filter studio test -- scripts/i18n/sync-upstream.test.ts`
Expected: PASS (relies only on Tasks 5–7 code).

- [ ] **Step 3: Write the sync script**

Create `apps/studio/scripts/i18n/sync-upstream.sh`:

```bash
#!/usr/bin/env bash
# Merge upstream Supabase into this fork without losing zh-CN translations.
# Translations live only in lib/i18n/locales/zh-CN.json (upstream never touches
# it). Source wrapping is regenerated, so .tsx conflicts are resolved by taking
# upstream and re-running the codemod.
set -euo pipefail

UPSTREAM_REF="${1:-upstream/master}"
STUDIO_DIR="$(cd "$(dirname "$0")/../.." && pwd)" # apps/studio
cd "$STUDIO_DIR/../.."                             # repo root

echo "==> Merging $UPSTREAM_REF (favoring upstream for source conflicts)"
git merge --no-commit --no-ff "$UPSTREAM_REF" || true
# Resolve any conflicted Studio source files in favor of upstream; the wrap is
# regenerated below, so their pre-merge wrapped form does not matter.
git checkout --theirs apps/studio/components apps/studio/pages 2>/dev/null || true
git add apps/studio/components apps/studio/pages 2>/dev/null || true

echo "==> Re-running codemod (idempotent)"
( cd apps/studio && pnpm exec tsx scripts/i18n/wrap.ts )

echo "==> Re-running incremental translation"
( cd apps/studio && pnpm exec tsx scripts/i18n/translate.ts )

git add apps/studio/components apps/studio/pages apps/studio/scripts/i18n/keys.json apps/studio/lib/i18n/locales/zh-CN.json
echo "==> Done. Review the diff, then commit the merge."
```

Make it executable: `chmod +x apps/studio/scripts/i18n/sync-upstream.sh`

- [ ] **Step 4: Write the optional merge driver**

Create `apps/studio/scripts/i18n/merge-driver.sh`:

```bash
#!/usr/bin/env bash
# Git merge driver for apps/studio/**/*.tsx: always take the upstream (theirs)
# version. The wrap is regenerated by sync-upstream.sh afterwards. Translations
# are never here (they live in zh-CN.json), so nothing is lost.
# Args (from .gitattributes): %O %A %B  -> base, ours, theirs
set -euo pipefail
BASE="$1"; OURS="$2"; THEIRS="$3"
cp "$THEIRS" "$OURS"
exit 0
```

Make it executable: `chmod +x apps/studio/scripts/i18n/merge-driver.sh`

Register it (documented in README, run once per clone):

```bash
git config merge.i18n-theirs.name "take upstream tsx, re-wrap later"
git config merge.i18n-theirs.driver "apps/studio/scripts/i18n/merge-driver.sh %O %A %B"
```

Add to repo-root `.gitattributes`:

```
apps/studio/components/**/*.tsx merge=i18n-theirs
apps/studio/pages/**/*.tsx merge=i18n-theirs
```

- [ ] **Step 5: Write the README**

Create `apps/studio/scripts/i18n/README.md` documenting: the English-as-key model, `wrap.ts` (idempotent), `translate.ts` (incremental, needs `I18N_TRANSLATE_*` env), the `zh-CN.json` guarantee, and the exact upstream-sync command:

```markdown
# Studio i18n (zh-CN)

- **Keys are English source strings.** Only `lib/i18n/locales/zh-CN.json` holds translations; upstream never touches it.
- **Wrap:** `pnpm exec tsx scripts/i18n/wrap.ts` (idempotent) — wraps UI strings, writes `keys.json`.
- **Translate:** set `I18N_TRANSLATE_ENDPOINT` / `I18N_TRANSLATE_API_KEY` / `I18N_TRANSLATE_MODEL`, then `pnpm exec tsx scripts/i18n/translate.ts` (only new keys).
- **Sync upstream:** `./scripts/i18n/sync-upstream.sh upstream/master` — merges, takes upstream source on conflict, re-wraps, re-translates. Translations are preserved automatically.
- Optional merge driver: register `merge.i18n-theirs` per the README so `.tsx` conflicts auto-resolve to upstream.
```

- [ ] **Step 6: Commit**

```bash
git add apps/studio/scripts/i18n/sync-upstream.sh apps/studio/scripts/i18n/merge-driver.sh apps/studio/scripts/i18n/README.md apps/studio/scripts/i18n/sync-upstream.test.ts .gitattributes
git commit -m "feat(studio): add i18n upstream-sync tooling and docs"
```

---

## Self-Review Notes

- **Spec coverage:** library+keying (Task 1), runtime provider (Task 2), switcher (Tasks 3, 9),
  codemod classify/transform/runner (Tasks 4–6), machine translate incremental (Task 7), full
  sweep + build verify (Task 8), zh-CN generation (Task 9), sync script + merge driver + docs +
  guarantee (Task 10). No `en.json` anywhere; `zh-CN.json` is the only catalog. All spec sections
  map to a task.
- **Type consistency:** `t`, `i18n`, `applyLocale`, `getInitialLocale`, `Locale`, `LOCALES` used
  consistently Tasks 1→3; `transformSourceFile` signature identical Tasks 5→6→10;
  `TranslationEngine`/`mergeTranslations` identical Tasks 7→10.
- **Idempotency** is asserted by tests in Tasks 5 and 6 and relied on by Task 10.
