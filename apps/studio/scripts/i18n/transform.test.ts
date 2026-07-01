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

  it('collapses multiline JSX text into a single-space key and stays reparseable', () => {
    const source = `export const C = () => (\n  <div>\n    Save\n    changes\n  </div>\n)`
    const { text, keys } = run(source)
    expect(text).toContain(`{t('Save changes')}`)
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
    expect(text).toContain(`toast.success(t('It\\'s a \\\\ backslash'))`)

    const project = new Project({ useInMemoryFileSystem: true })
    const sf = project.createSourceFile('C3.tsx', text)
    expect(() => transformSourceFile(sf)).not.toThrow()
    expect(transformSourceFile(sf).changed).toBe(false)
  })
})
