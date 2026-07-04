import { Project } from 'ts-morph'
import { describe, expect, it } from 'vitest'

import { collectDynamicLabelKeys, collectFromProject } from './wrap'

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
      `import { t as $t } from '@/lib/i18n'\nexport const A = () => <div>{$t('Alpha label')}</div>`
    )
    const { filesChanged } = collectFromProject(project)
    expect(filesChanged).toBe(0)
  })
})

describe('collectDynamicLabelKeys', () => {
  it('collects label properties and *_LABELS object values, nothing else', () => {
    const project = new Project({ useInMemoryFileSystem: true })
    project.createSourceFile(
      'registry.ts',
      [
        `export const REG = {`,
        `  'nav.home': { sequence: ['g', 'h'], label: 'Go to Project Overview' },`,
        `  'nav.dyn': { label: someVariable },`, // non-literal initializer: skipped
        `} as const`,
        `export const GROUP_LABELS: Record<string, string> = {`,
        `  'table-editor': 'Table Editor Group',`,
        `}`,
        `export const OTHER = { name: 'Not a label' }`,
      ].join('\n')
    )
    const keys = collectDynamicLabelKeys(project).sort()
    expect(keys).toEqual(['Go to Project Overview', 'Table Editor Group'])
  })
})
