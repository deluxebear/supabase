import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// [self-platform] M3.1: extends the M3.0 credential invariant to pages/api/v1
// (M3.0 final review swept v1 clean — this pins that state). Empty allowlist:
// any raw SUPABASE_SERVICE_KEY / AUTH_JWT_SECRET read under v1 must resolve
// per-ref instead, or be consciously added here with a row-gated fallback
// justification. Walker duplicated from pages/api/platform/
// credential-invariant.test.ts (importing across test files is worse than
// 10 duplicated lines).
const ROOT = join(__dirname)
const PATTERN = /process\.env\.(SUPABASE_SERVICE_KEY|AUTH_JWT_SECRET)/

const ALLOWED = new Set<string>([])

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) yield full
  }
}

describe('credential invariant (pages/api/v1)', () => {
  it('has no raw global credential reads', () => {
    const offenders: string[] = []
    for (const file of walk(ROOT)) {
      const rel = relative(ROOT, file)
      if (ALLOWED.has(rel)) continue
      if (PATTERN.test(readFileSync(file, 'utf8'))) offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })
})
