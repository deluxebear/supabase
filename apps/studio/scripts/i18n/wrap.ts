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
  const project = new Project({
    tsConfigFilePath: opts.tsConfigFilePath,
    skipAddingFilesFromTsConfig: true,
  })
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
    globs: [
      join(cwd, 'components/**/*.tsx'),
      join(cwd, 'pages/**/*.tsx'),
      '!' + join(cwd, '**/*.test.tsx'),
      '!' + join(cwd, '**/*.spec.tsx'),
    ],
    dryRun,
  })
  writeFileSync(join(cwd, 'scripts/i18n/keys.json'), JSON.stringify(keys.sort(), null, 2) + '\n')
  console.log(
    `i18n wrap: ${filesChanged} files changed, ${keys.length} unique keys` +
      (dryRun ? ' (dry run, nothing written)' : '')
  )
}
