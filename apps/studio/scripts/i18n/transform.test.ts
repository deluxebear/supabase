import { Node, Project, SyntaxKind, type ExpressionStatement, type StringLiteral } from 'ts-morph'
import { describe, expect, it } from 'vitest'

import { transformSourceFile } from './transform'

function run(source: string) {
  const project = new Project({ useInMemoryFileSystem: true })
  const sf = project.createSourceFile('C.tsx', source)
  const { keys } = transformSourceFile(sf)
  return { text: sf.getFullText(), keys }
}

describe('transformSourceFile', () => {
  it('wraps a JSX text node with $t() and imports it aliased', () => {
    const { text, keys } = run(`export const C = () => <div>Save changes</div>`)
    expect(text).toContain(`import { t as $t } from '@/lib/i18n'`)
    expect(text).toContain(`<div>{$t('Save changes')}</div>`)
    expect(keys).toContain('Save changes')
  })

  it('wraps an allowlisted attribute', () => {
    const { text } = run(`export const C = () => <input placeholder="Search tables" />`)
    expect(text).toContain(`placeholder={$t('Search tables')}`)
  })

  it('wraps string expressions and conditional text attributes', () => {
    const source = `export const C = ({ busy }: { busy: boolean }) => (
      <div title={busy ? 'Loading data' : 'Show data'}>
        {'Save changes'}
        <input placeholder={'Search tables'} className={busy ? 'Loading data' : 'ready'} />
      </div>
    )`
    const { text, keys } = run(source)

    expect(text).toContain(`title={busy ? $t('Loading data') : $t('Show data')}`)
    expect(text).toContain(`{$t('Save changes')}`)
    expect(text).toContain(`placeholder={$t('Search tables')}`)
    expect(text).toContain(`className={busy ? 'Loading data' : 'ready'}`)
    expect(keys).toEqual(['Loading data', 'Show data', 'Save changes', 'Search tables'])

    const project = new Project({ useInMemoryFileSystem: true })
    const sf = project.createSourceFile('C.tsx', text)
    expect(transformSourceFile(sf).changed).toBe(false)
  })

  it('translates dynamic display fields when rendered', () => {
    const { text } = run(
      `export const C = ({ item }) => <div title={item.title}>{item.description}</div>`
    )
    expect(text).toContain(`translateDisplayValue as $tValue`)
    expect(text).toContain(`title={$tValue(item.title)}`)
    expect(text).toContain(`{$tValue(item.description)}`)

    const project = new Project({ useInMemoryFileSystem: true })
    const sf = project.createSourceFile('C.tsx', text)
    expect(transformSourceFile(sf).changed).toBe(false)
  })

  it('keeps the static translator import for dynamic translation calls', () => {
    const source = `import { t as $t, translateDisplayValue as $tValue } from '@/lib/i18n'
export const C = ({ item }) => <div>{$t(item.name)}{$tValue(item.title)}</div>`
    const { text } = run(source)
    expect(text).toContain(`t as $t`)
    expect(text).toContain(`$t(item.name)`)
  })

  it('leaves structural attributes alone', () => {
    const { text } = run(`export const C = () => <div className="Save changes" />`)
    expect(text).toContain(`className="Save changes"`)
    expect(text).not.toContain('t(')
  })

  it('wraps a sonner toast string argument', () => {
    const src = `import { toast } from 'sonner'\nexport const f = () => toast.success('Saved successfully')`
    const { text } = run(src)
    expect(text).toContain(`toast.success($t('Saved successfully'))`)
  })

  it('does not collide with a local identifier named t in scope', () => {
    const { text } = run(`export const C = () => arr.map((t) => <div>Save changes</div>)`)
    expect(text).toContain(`$t('Save changes')`)
    expect(text).not.toMatch(/[^$]t\('Save changes'\)/)

    const project = new Project({ useInMemoryFileSystem: true })
    const sf = project.createSourceFile('C4.tsx', text)
    expect(transformSourceFile(sf).changed).toBe(false)
  })

  it('is idempotent — a second pass makes no changes', () => {
    const once = run(`export const C = () => <div>Hello there</div>`).text
    const project = new Project({ useInMemoryFileSystem: true })
    const sf = project.createSourceFile('C.tsx', once)
    const { changed } = transformSourceFile(sf)
    expect(changed).toBe(false)
    expect(sf.getFullText()).toBe(once)
  })

  it('collects keys from already-wrapped $t() calls without marking the file changed', () => {
    const src = [
      `import { t as $t } from '@/lib/i18n'`,
      `export const C = () => (`,
      `  <div title={$t("Couldn't fetch")}>{$t('Save changes')}</div>`,
      `)`,
    ].join('\n')
    const project = new Project({ useInMemoryFileSystem: true })
    const sf = project.createSourceFile('C6.tsx', src)
    const { keys, changed } = transformSourceFile(sf)
    expect(changed).toBe(false)
    expect(keys).toContain('Save changes')
    expect(keys).toContain("Couldn't fetch")
    expect(sf.getFullText()).toBe(src)
  })

  it('does not wrap non-translatable text', () => {
    const { text, keys } = run(`export const C = () => <div>{count}</div>`)
    expect(keys).toEqual([])
    expect(text).not.toContain('t(')
  })

  it('collapses multiline JSX text into a single-space key and stays reparseable', () => {
    const source = `export const C = () => (\n  <div>\n    Save\n    changes\n  </div>\n)`
    const { text, keys } = run(source)
    expect(text).toContain(`{$t('Save changes')}`)
    expect(keys).toContain('Save changes')

    // Ensure the emitted output is valid, reparseable TS with no stray raw newlines.
    const project = new Project({ useInMemoryFileSystem: true })
    const sf = project.createSourceFile('C2.tsx', text)
    expect(() => transformSourceFile(sf)).not.toThrow()
    expect(transformSourceFile(sf).changed).toBe(false)
  })

  it('escapes single quotes and backslashes together without corrupting the string', () => {
    const src = `import { toast } from 'sonner'\nexport const f = () => toast.success('It\\'s a \\\\ backslash')`
    const { text, keys } = run(src)
    expect(keys).toContain("It's a \\ backslash")
    expect(text).toContain(`toast.success($t('It\\'s a \\\\ backslash'))`)

    const project = new Project({ useInMemoryFileSystem: true })
    const sf = project.createSourceFile('C3.tsx', text)
    expect(() => transformSourceFile(sf)).not.toThrow()
    expect(transformSourceFile(sf).changed).toBe(false)
  })

  it('inserts the injected import after a leading "use client" directive', () => {
    const source = `'use client'\n\nimport { Foo } from 'foo'\n\nexport const C = () => <div>Save changes</div>\n`
    const { text } = run(source)

    expect(text).not.toContain(`;('use client')`)
    expect(text).toContain(`$t('Save changes')`)

    const project = new Project({ useInMemoryFileSystem: true })
    const sf = project.createSourceFile('C5.tsx', text)
    const statements = sf.getStatements()
    const first = statements[0]
    expect(first.getKind()).toBe(SyntaxKind.ExpressionStatement)
    const firstExpr = (first as ExpressionStatement).getExpression()
    expect(Node.isStringLiteral(firstExpr)).toBe(true)
    expect((firstExpr as StringLiteral).getLiteralValue()).toBe('use client')

    const importIndex = statements.findIndex(
      (s) => Node.isImportDeclaration(s) && s.getModuleSpecifierValue() === '@/lib/i18n'
    )
    expect(importIndex).toBeGreaterThan(0)

    // A second transform pass over the emitted output should be a no-op — this
    // confirms the output is well-formed enough to reparse and re-analyze
    // without spuriously re-triggering the codemod.
    expect(transformSourceFile(sf).changed).toBe(false)
  })

  it('inserts the injected import at the top when there is no directive prologue', () => {
    const source = `import { Foo } from 'foo'\n\nexport const C = () => <div>Save changes</div>\n`
    const { text } = run(source)

    const lines = text.split('\n').filter((l) => l.trim().length > 0)
    expect(lines[0]).toContain(`import { t as $t } from '@/lib/i18n'`)
  })
  it('wraps dynamic toast sentences as interpolation and remains idempotent', () => {
    const { text, keys } = run('toast.success(`Your secret API key ${data.prefix}... is ready.`)')
    expect(keys).toContain('Your secret API key {{value0}}... is ready.')
    expect(text).toContain(
      "$t('Your secret API key {{value0}}... is ready.', { value0: data.prefix })"
    )
    const project = new Project({ useInMemoryFileSystem: true })
    const sf = project.createSourceFile('toast.ts', text)
    expect(transformSourceFile(sf).changed).toBe(false)
    expect(transformSourceFile(sf).keys).toContain('Your secret API key {{value0}}... is ready.')
  })

  it('preserves multiple interpolated expressions and escaped template text', () => {
    const { text, keys } = run(
      'toast.error(`Failed to delete "${name}" (${count}): ${error.message}`)'
    )
    expect(keys).toEqual(['Failed to delete "{{value0}}" ({{value1}}): {{value2}}'])
    expect(text).toContain('value0: name, value1: count, value2: error.message')
  })

  it('wraps conditional messages and descriptions without changing backend errors or options', () => {
    const { text, keys } = run(
      `toast.error(error.message ?? 'Unable to save', { description: ok ? 'Try again' : 'Contact support', id: 'save-toast' })`
    )
    expect(keys.sort()).toEqual(['Contact support', 'Try again', 'Unable to save'])
    expect(text).toContain("error.message ?? $t('Unable to save')")
    expect(text).toContain("description: ok ? $t('Try again') : $t('Contact support')")
    expect(text).toContain("id: 'save-toast'")
  })

  it('wraps promise notifications including callback return values', () => {
    const { text, keys } = run(
      'toast.promise(request, { loading: "Saving changes", success: (data) => `Saved ${data.name}`, error: () => { return "Unable to save" } })'
    )
    expect(keys.sort()).toEqual(['Saved {{value0}}', 'Saving changes', 'Unable to save'])
    expect(text).toContain("success: (data) => $t('Saved {{value0}}', { value0: data.name })")
  })

  it('limits notification-only transformations to toasts', () => {
    const project = new Project({ useInMemoryFileSystem: true })
    const sf = project.createSourceFile(
      'C.tsx',
      'export const C = () => <div>Keep this text</div>\n toast.success(`Saved changes`)'
    )
    const { keys } = transformSourceFile(sf, { toastsOnly: true })
    expect(keys).toEqual(['Saved changes'])
    expect(sf.getFullText()).toContain('<div>Keep this text</div>')
  })
  it('wraps concatenated notifications while preserving operand order', () => {
    const { text, keys } = run("toast.error('Failed to copy schema: ' + (err.message || err))")
    expect(keys).toEqual(['Failed to copy schema: {{value0}}'])
    expect(text).toContain(
      "$t('Failed to copy schema: {{value0}}', { value0: (err.message || err) })"
    )
  })

  it('localizes custom progress messages and preserves numeric props', () => {
    const project = new Project({ useInMemoryFileSystem: true })
    const sf = project.createSourceFile(
      'progress.tsx',
      'toast(<Progress value={100} message={`Uploading ${count} files`} />)'
    )
    const { keys } = transformSourceFile(sf, { toastsOnly: true })
    expect(keys).toEqual(['Uploading {{value0}} files'])
    expect(sf.getFullText()).toContain('value={100}')
    expect(sf.getFullText()).toContain(
      "message={$t('Uploading {{value0}} files', { value0: count })}"
    )
  })

  it('translates local message variables without evaluating static configuration', () => {
    const { text } = run(
      "const title = 'Static title'; function save() { const message = `Saved ${name}`; toast.success(message) }"
    )
    expect(text).toContain("const title = 'Static title'")
    expect(text).toContain("const message = $t('Saved {{value0}}', { value0: name })")
  })

  it('translates grammatical suffixes and default errors inside interpolation', () => {
    const { text, keys } = run(
      'toast.error(`Deleted ${count} row${count > 1 ? "s" : ""}: ${error.message ?? "Unknown error"}`)'
    )
    expect(keys).toContain('s')
    expect(keys).toContain('Unknown error')
    expect(text).toContain("count > 1 ? $t('s') :")
    expect(text).toContain("error.message ?? $t('Unknown error')")
  })
})
