import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Node, Project } from 'ts-morph'

import { transformSourceFile } from './transform'

export function collectFromProject(
  project: Project,
  options: { toastsOnly?: boolean } = {}
): { filesChanged: number; keys: string[] } {
  const keys = new Set<string>()
  let filesChanged = 0
  for (const sf of project.getSourceFiles()) {
    const { keys: fileKeys, changed } = transformSourceFile(sf, options)
    if (changed) filesChanged++
    for (const k of fileKeys) keys.add(k)
  }
  return { filesChanged, keys: [...keys] }
}

// Some UI text lives in module-scope constant/schema objects (shortcut registry
// labels, the ConnectSheet mode/field/step schema, chart-interval labels), so it
// can't carry $t() at the definition site — it would evaluate before the locale
// is set. Those are translated at render time instead ($t(def.label) /
// $t(step.title) / $t(field.description), etc.). Collect the string values here
// so keys.json stays the full key list: `label:`/`title:`/`description:`
// properties, plus the string values of *_LABELS lookup objects.
const DYNAMIC_TEXT_PROPS = new Set(['label', 'title', 'description'])
export function collectDynamicLabelKeys(project: Project): string[] {
  const keys = new Set<string>()
  for (const sf of project.getSourceFiles()) {
    sf.forEachDescendant((node) => {
      if (!Node.isPropertyAssignment(node)) return
      const init = node.getInitializer()
      if (!init || !Node.isStringLiteral(init)) return
      const value = init.getLiteralValue()
      if (value.trim().length === 0) return
      const isTextProp = DYNAMIC_TEXT_PROPS.has(node.getNameNode().getText())
      const labelsObject = node.getFirstAncestor(
        (a) => Node.isVariableDeclaration(a) && /LABELS$/.test(a.getName())
      )
      if (isTextProp || labelsObject) keys.add(value)
    })
  }
  return [...keys]
}

export function wrapProject(opts: {
  tsConfigFilePath: string
  globs: string[]
  dryRun?: boolean
  toastsOnly?: boolean
}): { filesChanged: number; keys: string[]; dynamicKeyCount: number } {
  const project = new Project({
    tsConfigFilePath: opts.tsConfigFilePath,
    skipAddingFilesFromTsConfig: true,
  })
  project.addSourceFilesAtPaths(opts.globs)
  const result = collectFromProject(project, opts)
  const dynamicKeys = collectDynamicLabelKeys(project)
  if (!opts.dryRun) project.saveSync()
  return {
    ...result,
    keys: [...new Set([...result.keys, ...dynamicKeys])],
    dynamicKeyCount: dynamicKeys.length,
  }
}

// CLI: pnpm --filter studio exec tsx scripts/i18n/wrap.ts [--dry]
if (process.argv[1] && process.argv[1].endsWith('wrap.ts')) {
  const dryRun = process.argv.includes('--dry')
  const toastsOnly = process.argv.includes('--toasts-only')
  const cwd = process.cwd() // apps/studio
  const { filesChanged, keys, dynamicKeyCount } = wrapProject({
    tsConfigFilePath: join(cwd, 'tsconfig.json'),
    globs: [
      // .ts files carry no JSX, but they do carry user-facing sonner toasts
      // and hand-wrapped $t() menu labels that must land in keys.json.
      ...['components', 'pages', 'routes', 'data', 'hooks', 'lib', 'state'].map((dir) =>
        join(cwd, dir, '**/*.{ts,tsx}')
      ),
      '!' + join(cwd, '**/__generated__/**'),
      '!' + join(cwd, '**/*.gen.ts'),
      '!' + join(cwd, 'lib/i18n/**'),
      '!' + join(cwd, '**/*.test.{ts,tsx}'),
      '!' + join(cwd, '**/*.spec.{ts,tsx}'),
    ],
    dryRun,
    toastsOnly,
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
    // ConnectSheet mode/field/step schema + connection-method constants are
    // rendered via $t(field.label)/$t(step.title)/$t(option.description) etc.
    join(cwd, 'components/interfaces/ConnectSheet/connect.schema.ts'),
    join(cwd, 'components/interfaces/ConnectSheet/Connect.constants.ts'),
    '!' + join(cwd, '**/*.test.{ts,tsx}'),
  ])
  const dynamicKeys = collectDynamicLabelKeys(dynamicProject)
  const allKeys = [...new Set([...keys, ...dynamicKeys])].sort()
  writeFileSync(join(cwd, 'scripts/i18n/keys.json'), JSON.stringify(allKeys, null, 2) + '\n')
  console.log(
    `i18n wrap: ${filesChanged} files changed, ${allKeys.length} unique keys ` +
      `(${dynamicKeyCount + dynamicKeys.length} dynamic labels)` +
      (dryRun ? ' (dry run, nothing written)' : '')
  )
}
