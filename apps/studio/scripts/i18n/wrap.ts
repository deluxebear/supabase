import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Node, Project } from 'ts-morph'

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

// Shortcut registry labels are module-scope constants, so they can't carry
// $t() at the definition site (it would evaluate before the locale is set) —
// they are translated at render time instead ($t(def.label) in useShortcut /
// ShortcutTooltip / ShortcutsReferenceSheet). Collect them here so keys.json
// stays the full key list: `label: '...'` properties, plus the string values
// of *_LABELS lookup objects (reference-sheet group names).
export function collectDynamicLabelKeys(project: Project): string[] {
  const keys = new Set<string>()
  for (const sf of project.getSourceFiles()) {
    sf.forEachDescendant((node) => {
      if (!Node.isPropertyAssignment(node)) return
      const init = node.getInitializer()
      if (!init || !Node.isStringLiteral(init)) return
      const isLabelProp = node.getNameNode().getText() === 'label'
      const labelsObject = node.getFirstAncestor(
        (a) => Node.isVariableDeclaration(a) && /LABELS$/.test(a.getName())
      )
      if (isLabelProp || labelsObject) keys.add(init.getLiteralValue())
    })
  }
  return [...keys]
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
  const dynamicProject = new Project({
    tsConfigFilePath: join(cwd, 'tsconfig.json'),
    skipAddingFilesFromTsConfig: true,
  })
  dynamicProject.addSourceFilesAtPaths([
    join(cwd, 'state/shortcuts/**/*.{ts,tsx}'),
    join(cwd, 'components/ui/GlobalShortcuts/ShortcutsReferenceSheet.tsx'),
    // CHART_INTERVALS labels ('Last 24 hours', …) are module-scope constants
    // translated at render via $t(i.label) in ChartIntervalDropdown, so their
    // `label:` keys must be collected here too.
    join(cwd, 'components/ui/Logs/logs.utils.ts'),
    '!' + join(cwd, '**/*.test.{ts,tsx}'),
  ])
  const dynamicKeys = collectDynamicLabelKeys(dynamicProject)
  const allKeys = [...new Set([...keys, ...dynamicKeys])].sort()
  writeFileSync(join(cwd, 'scripts/i18n/keys.json'), JSON.stringify(allKeys, null, 2) + '\n')
  console.log(
    `i18n wrap: ${filesChanged} files changed, ${allKeys.length} unique keys ` +
      `(${dynamicKeys.length} dynamic labels)` +
      (dryRun ? ' (dry run, nothing written)' : '')
  )
}
