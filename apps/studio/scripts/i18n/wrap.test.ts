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
      `import { t as $t } from '@/lib/i18n'\nexport const A = () => <div>{$t('Alpha label')}</div>`
    )
    const { filesChanged } = collectFromProject(project)
    expect(filesChanged).toBe(0)
  })
})
