import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

// [self-platform] M2.2 final review verified every remaining raw
// SUPABASE_SERVICE_KEY / AUTH_JWT_SECRET read under pages/api/platform is a
// row-gated plain-self-hosted fallback. This test pins that inventory: new
// raw reads must either resolve per-ref or be consciously added here.
const ROOT = join(__dirname)
const PATTERN = /process\.env\.(SUPABASE_SERVICE_KEY|AUTH_JWT_SECRET)/

// Verified against `git grep -nE 'process\.env\.(SUPABASE_SERVICE_KEY|AUTH_JWT_SECRET)' --
// apps/studio/pages/api/platform` at Task 15 time. In addition to the six
// routes tracked through M2.2 (temporary/rest/graphql/config/props), the
// per-ref auth-admin routes added afterwards (invite/magiclink/otp/recover —
// "auth admin + link routes resolve per-ref") follow the exact same
// row-gated pattern (resolveProjectConnection with a global-env fallback
// only when there is no registry row) and are included here for the same
// reason. Flagged to the controller as a real (expected) inventory delta
// from the Task 15 brief's six-entry list, not a silent whitelist.
const ALLOWED = new Set([
  'projects/[ref]/api-keys/temporary.ts',
  'projects/[ref]/api/rest.ts',
  'projects/[ref]/api/graphql.ts',
  'projects/[ref]/config/index.ts',
  'projects/[ref]/config/postgrest.ts',
  'props/project/[ref]/api.ts',
  'auth/[ref]/invite.ts',
  'auth/[ref]/magiclink.ts',
  'auth/[ref]/otp.ts',
  'auth/[ref]/recover.ts',
])

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) yield* walk(full)
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) yield full
  }
}

describe('credential invariant (pages/api/platform)', () => {
  it('has no raw global credential reads outside the allowed row-gated fallbacks', () => {
    const offenders: string[] = []
    for (const file of walk(ROOT)) {
      const rel = relative(ROOT, file)
      if (ALLOWED.has(rel)) continue
      if (PATTERN.test(readFileSync(file, 'utf8'))) offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })
})
