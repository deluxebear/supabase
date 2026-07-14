import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadQueryOptions(platform: string, selfPlatform: string) {
  vi.doUnmock('common')
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_IS_PLATFORM', platform)
  vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', selfPlatform)
  return (await import('./incident-banner-query')).incidentBannerQueryOptions()
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('incidentBannerQueryOptions', () => {
  it('enables incident.io banners for Supabase cloud', async () => {
    const options = await loadQueryOptions('true', '')
    expect(options.enabled).toBe(true)
  })

  it('disables hosted incident.io banners for self-platform', async () => {
    const options = await loadQueryOptions('true', 'true')
    expect(options.enabled).toBe(false)
  })

  it('disables hosted incident.io banners for plain self-hosted Studio', async () => {
    const options = await loadQueryOptions('', '')
    expect(options.enabled).toBe(false)
  })
})
