import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadAllowlist(selfPlatform: string | undefined) {
  vi.resetModules()
  if (selfPlatform === undefined) {
    vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', '')
  } else {
    vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', selfPlatform)
  }
  return await import('./hosted-api-allowlist')
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('isHostedSupportedApiPath', () => {
  it('keeps rejecting non-allowlisted paths when self-platform is off', async () => {
    const { isHostedSupportedApiPath } = await loadAllowlist(undefined)
    expect(isHostedSupportedApiPath('/api/platform/profile')).toBe(false)
    expect(isHostedSupportedApiPath('/api/ai/docs')).toBe(true)
  })

  it('allows /api/platform/** and /api/v1/** when self-platform is on', async () => {
    const { isHostedSupportedApiPath } = await loadAllowlist('true')
    expect(isHostedSupportedApiPath('/api/platform/profile')).toBe(true)
    expect(isHostedSupportedApiPath('/api/platform/organizations/default/projects')).toBe(true)
    expect(isHostedSupportedApiPath('/api/v1/projects/default/api-keys')).toBe(true)
    expect(isHostedSupportedApiPath('/api/ai/docs')).toBe(true)
  })

  it('still rejects unrelated api paths when self-platform is on', async () => {
    const { isHostedSupportedApiPath } = await loadAllowlist('true')
    expect(isHostedSupportedApiPath('/api/totally-unknown')).toBe(false)
  })

  // [self-platform] C1 hardening: matching used to be `.includes`, so a
  // smuggled path with `/api/v1/` or `/api/platform/` anywhere mid-string
  // (not just as the actual API prefix) would incorrectly pass.
  it('rejects a smuggled path where /api/platform/ or /api/v1/ only appears mid-string', async () => {
    const { isHostedSupportedApiPath } = await loadAllowlist('true')
    expect(isHostedSupportedApiPath('/foo/api/v1/projects/default/api-keys')).toBe(false)
    expect(isHostedSupportedApiPath('/foo/api/platform/profile')).toBe(false)
  })
})
