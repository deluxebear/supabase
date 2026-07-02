import { Project } from 'ts-morph'
import { describe, expect, it } from 'vitest'

import { mergeTranslations, type TranslationEngine } from './translate'
import { collectFromProject } from './wrap'

const engine: TranslationEngine = {
  translate: async (keys) => Object.fromEntries(keys.map((k) => [k, `zh:${k}`])),
}

describe('upstream sync regeneration', () => {
  it('wraps a newly added upstream string and keeps existing translations', async () => {
    // Simulate post-merge source: one already-wrapped string (as emitted by the
    // codemod, using the `$t` alias) + one new upstream string that hasn't been
    // wrapped yet.
    const project = new Project({ useInMemoryFileSystem: true })
    project.createSourceFile(
      'C.tsx',
      `import { t as $t } from '@/lib/i18n'\n` +
        `export const C = () => <div>{$t('Existing')}<span>Brand new</span></div>`
    )
    const { keys } = collectFromProject(project)
    expect(keys).toContain('Brand new')

    const existing = { Existing: '已存在' }
    const merged = await mergeTranslations([...keys, 'Existing'], existing, engine)
    expect(merged['Existing']).toBe('已存在') // preserved, not overwritten
    expect(merged['Brand new']).toBe('zh:Brand new') // newly translated
  })
})
