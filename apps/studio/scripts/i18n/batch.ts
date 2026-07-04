// Batch-translation helper for the LLM-subagent translation path (no
// I18N_TRANSLATE_* credentials). Complements translate.ts, which needs an
// OpenAI-compatible endpoint; this tool instead prepares/validates/merges
// file-based batches that translation subagents read and write.
//
// Usage (cwd = apps/studio):
//   pnpm exec tsx scripts/i18n/batch.ts split [--batch-size 150] [--dir <workdir>]
//   pnpm exec tsx scripts/i18n/batch.ts check [--dir <workdir>]
//   pnpm exec tsx scripts/i18n/batch.ts merge [--dir <workdir>]
//
// split: diff keys.json against zh-CN.json, write batch-NN.in.json slices of
//        the missing keys into the workdir.
// check: validate each batch-NN.out.json against its .in.json (invalid JSON,
//        missing keys, hallucinated keys, still-English values) and flag REDO.
// merge: ingest every *.out.json, keep only valid translations (key exists in
//        the master list, value non-empty and different from the key), merge
//        over the existing catalog without ever deleting entries, write the
//        sorted catalog back, and report coverage + remaining keys.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const KEYS_PATH = join(process.cwd(), 'scripts/i18n/keys.json')
const CATALOG_PATH = join(process.cwd(), 'lib/i18n/locales/zh-CN.json')

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const command = process.argv[2]
const workdir = arg('--dir', join(tmpdir(), 'studio-i18n-batches'))

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function loadMaster(): { keys: string[]; catalog: Record<string, string> } {
  return {
    keys: readJson<string[]>(KEYS_PATH),
    catalog: readJson<Record<string, string>>(CATALOG_PATH),
  }
}

function missingKeys(): string[] {
  const { keys, catalog } = loadMaster()
  return keys.filter((k) => !(k in catalog))
}

function split() {
  const batchSize = Number(arg('--batch-size', '150'))
  const missing = missingKeys()
  mkdirSync(workdir, { recursive: true })
  const batches = Math.ceil(missing.length / batchSize)
  for (let i = 0; i < batches; i++) {
    const id = String(i + 1).padStart(2, '0')
    writeFileSync(
      join(workdir, `batch-${id}.in.json`),
      JSON.stringify(missing.slice(i * batchSize, (i + 1) * batchSize), null, 2) + '\n'
    )
  }
  console.log(`missing keys: ${missing.length}`)
  console.log(`batches: ${batches} x ~${batchSize} -> ${workdir}/batch-NN.in.json`)
  if (missing.length === 0) console.log('Nothing to translate.')
}

function check() {
  const files = existsSync(workdir)
    ? readdirSync(workdir).filter((f) => f.endsWith('.in.json'))
    : []
  if (files.length === 0) {
    console.log(`no batch-NN.in.json files in ${workdir} — run split first`)
    return
  }
  let redo = 0
  for (const inFile of files.sort()) {
    const outFile = inFile.replace('.in.json', '.out.json')
    const input = readJson<string[]>(join(workdir, inFile))
    let out: Record<string, string>
    try {
      out = readJson<Record<string, string>>(join(workdir, outFile))
    } catch {
      console.log(`${outFile}: MISSING or INVALID JSON  <-- REDO`)
      redo++
      continue
    }
    const inSet = new Set(input)
    const missing = input.filter((k) => !(k in out)).length
    const extra = Object.keys(out).filter((k) => !inSet.has(k)).length
    const identical = input.filter((k) => out[k] === k).length
    const flag = missing > 0 || identical > input.length * 0.5 ? '  <-- REDO' : ''
    if (flag) redo++
    console.log(
      `${outFile}: in=${input.length} out=${Object.keys(out).length} missing=${missing} extra=${extra} stillEnglish=${identical}${flag}`
    )
  }
  console.log(redo === 0 ? 'all batches OK — run merge' : `${redo} batch(es) need re-translation`)
}

function merge() {
  const { keys, catalog } = loadMaster()
  const masterSet = new Set(keys)
  const merged: Record<string, string> = { ...catalog }
  let added = 0
  const outFiles = existsSync(workdir)
    ? readdirSync(workdir).filter((f) => f.endsWith('.out.json'))
    : []
  for (const f of outFiles.sort()) {
    let obj: Record<string, string>
    try {
      obj = readJson<Record<string, string>>(join(workdir, f))
    } catch {
      console.log(`SKIP invalid ${f}`)
      continue
    }
    for (const [k, v] of Object.entries(obj)) {
      if (!masterSet.has(k)) continue // hallucinated / altered key
      if (typeof v !== 'string' || v.length === 0) continue
      if (v === k) continue // value == key means "kept English" — fallback handles it
      if (!(k in merged)) {
        merged[k] = v
        added++
      }
    }
  }
  const sorted = Object.fromEntries(
    Object.keys(merged)
      .sort()
      .map((k) => [k, merged[k]])
  )
  writeFileSync(CATALOG_PATH, JSON.stringify(sorted, null, 2) + '\n')
  const remaining = keys.filter((k) => !(k in sorted))
  mkdirSync(workdir, { recursive: true })
  writeFileSync(join(workdir, 'remaining.json'), JSON.stringify(remaining, null, 2) + '\n')
  const coverage = ((Object.keys(sorted).length / keys.length) * 100).toFixed(1)
  console.log(`added: ${added} | catalog: ${Object.keys(sorted).length} | coverage: ${coverage}%`)
  console.log(`remaining (fall back to English): ${remaining.length} -> ${workdir}/remaining.json`)
}

if (command === 'split') split()
else if (command === 'check') check()
else if (command === 'merge') merge()
else {
  console.log('usage: tsx scripts/i18n/batch.ts <split|check|merge> [--batch-size N] [--dir path]')
  process.exit(1)
}
