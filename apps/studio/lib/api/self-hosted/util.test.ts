import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadUtil(env: { isPlatform: string; selfPlatform: string }) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_IS_PLATFORM', env.isPlatform)
  vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', env.selfPlatform)
  return await import('./util')
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('assertSelfHosted', () => {
  it('passes in plain self-hosted mode', async () => {
    const { assertSelfHosted } = await loadUtil({ isPlatform: 'false', selfPlatform: '' })
    expect(() => assertSelfHosted()).not.toThrow()
  })

  it('throws in platform mode without self-platform', async () => {
    const { assertSelfHosted } = await loadUtil({ isPlatform: 'true', selfPlatform: '' })
    expect(() => assertSelfHosted()).toThrow()
  })

  it('passes in self-platform mode', async () => {
    const { assertSelfHosted } = await loadUtil({ isPlatform: 'true', selfPlatform: 'true' })
    expect(() => assertSelfHosted()).not.toThrow()
  })
})
