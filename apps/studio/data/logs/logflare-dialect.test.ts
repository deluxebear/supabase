import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadDialect(platform: string, selfPlatform: string) {
  // [self-platform] `vi.doUnmock('common')` is required here: tests/vitestSetup.ts
  // globally mocks the `common` package by spreading `await importOriginal()`
  // inside its factory. That `actual` resolution is memoized across
  // `vi.resetModules()` calls within a single test file (a Vitest/vite-node
  // quirk — resetModules clears vitest's own registry but not the mock
  // factory's cached `importOriginal` result), so re-stubbing
  // NEXT_PUBLIC_IS_PLATFORM to a *different* value later in the same file
  // would silently keep resolving IS_PLATFORM to whatever the first test in
  // the file saw. Unmocking first forces a genuinely fresh resolution.
  vi.doUnmock('common')
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_IS_PLATFORM', platform)
  vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', selfPlatform)
  return await import('./logflare-dialect')
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('USE_LOGFLARE_PG_SQL', () => {
  it('is false for cloud (IS_PLATFORM=true, SELF_PLATFORM unset)', async () => {
    const mod = await loadDialect('true', '')
    expect(mod.USE_LOGFLARE_PG_SQL).toBe(false)
  })

  it('is true for a self-platform build (IS_PLATFORM=true AND SELF_PLATFORM=true)', async () => {
    // [self-platform] a self-platform build sets BOTH flags — this is the
    // case the spec's naive `!IS_PLATFORM` shorthand would have missed.
    const mod = await loadDialect('true', 'true')
    expect(mod.USE_LOGFLARE_PG_SQL).toBe(true)
  })

  it('is true for plain self-hosted (IS_PLATFORM=false, SELF_PLATFORM=false)', async () => {
    const mod = await loadDialect('', '')
    expect(mod.USE_LOGFLARE_PG_SQL).toBe(true)
  })
})

describe('pickDialect', () => {
  it('returns the pg branch when USE_LOGFLARE_PG_SQL is true', async () => {
    const mod = await loadDialect('', '')
    expect(mod.pickDialect('pg-text', 'bq-text')).toBe('pg-text')
  })

  it('returns the bq branch when USE_LOGFLARE_PG_SQL is false (cloud)', async () => {
    const mod = await loadDialect('true', '')
    expect(mod.pickDialect('pg-text', 'bq-text')).toBe('bq-text')
  })
})
