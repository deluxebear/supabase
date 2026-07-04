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
      // .ts files carry no JSX, but they do carry user-facing sonner toasts
      // and hand-wrapped $t() menu labels that must land in keys.json.
      join(cwd, 'components/**/*.{ts,tsx}'),
      join(cwd, 'pages/**/*.{ts,tsx}'),
      '!' + join(cwd, '**/*.test.{ts,tsx}'),
      '!' + join(cwd, '**/*.spec.{ts,tsx}'),
    ],
    dryRun,
  })
  writeFileSync(join(cwd, 'scripts/i18n/keys.json'), JSON.stringify(keys.sort(), null, 2) + '\n')
  console.log(
    `i18n wrap: ${filesChanged} files changed, ${keys.length} unique keys` +
      (dryRun ? ' (dry run, nothing written)' : '')
  )
}
