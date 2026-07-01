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
