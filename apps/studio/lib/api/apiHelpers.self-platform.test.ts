import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// [self-platform] `constructHeaders` reads IS_PLATFORM / IS_SELF_PLATFORM at module load, so
// each env combination needs a fresh module instance (same pattern as
// lib/hosted-api-allowlist.test.ts and lib/api/self-hosted/util.test.ts).
async function loadApiHelpers(env: { isPlatform: string; selfPlatform: string }) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_IS_PLATFORM', env.isPlatform)
  vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', env.selfPlatform)
  return await import('./apiHelpers')
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('constructHeaders (self-platform env matrix)', () => {
  beforeEach(() => {
    process.env.SUPABASE_SERVICE_KEY = 'test-service-key'
  })

  it('keeps the pg-meta apiKey header in plain self-hosted mode', async () => {
    const { constructHeaders } = await loadApiHelpers({ isPlatform: 'false', selfPlatform: '' })
    const result = constructHeaders({ Accept: 'application/json' })
    expect(result.apiKey).toBe('test-service-key')
  })

  it('strips the pg-meta apiKey header in real platform mode (not self-platform)', async () => {
    const { constructHeaders } = await loadApiHelpers({ isPlatform: 'true', selfPlatform: '' })
    const result = constructHeaders({ Accept: 'application/json' })
    expect(result.apiKey).toBeUndefined()
  })

  it('[self-platform] keeps the pg-meta apiKey header when self-platform is on', async () => {
    const { constructHeaders } = await loadApiHelpers({ isPlatform: 'true', selfPlatform: 'true' })
    const result = constructHeaders({ Accept: 'application/json' })
    expect(result.apiKey).toBe('test-service-key')
  })
})
