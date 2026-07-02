import { afterEach, describe, expect, it, vi } from 'vitest'

const createClient = vi.fn(() => ({ marker: 'per-ref-client' }))
vi.mock('@supabase/supabase-js', () => ({ createClient }))

const resolveProjectConnection = vi.fn()
vi.mock('@/lib/api/self-platform/resolve-connection', () => ({
  resolveProjectConnection,
  ProjectNotFound: class ProjectNotFound extends Error {},
}))

async function loadModule(selfPlatform: string) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', selfPlatform)
  vi.stubEnv('SUPABASE_PUBLIC_URL', 'http://public-global:8000')
  return await import('./self-hosted-admin')
}

afterEach(() => {
  vi.unstubAllEnvs()
  createClient.mockClear()
  resolveProjectConnection.mockReset()
})

describe('getAdminContextForRef', () => {
  it('self-platform off: global client, no resolver call', async () => {
    const mod = await loadModule('')
    const ctx = await mod.getAdminContextForRef('default')
    expect(resolveProjectConnection).not.toHaveBeenCalled()
    expect(ctx.client).toBe(mod.selfHostedSupabaseAdmin)
    expect(ctx.publicBaseUrl).toBe('http://public-global:8000')
  })

  it('self-platform on + registry hit: per-ref client from kong url + service key', async () => {
    const mod = await loadModule('true')
    resolveProjectConnection.mockResolvedValueOnce({
      row: { id: 2 },
      supabaseUrl: 'http://kong-b:8100',
      serviceKey: 'service-b',
    })
    const ctx = await mod.getAdminContextForRef('proj-b')
    expect(resolveProjectConnection).toHaveBeenCalledWith('proj-b')
    expect(createClient).toHaveBeenCalledWith('http://kong-b:8100', 'service-b')
    expect(ctx.client).toEqual({ marker: 'per-ref-client' })
    expect(ctx.publicBaseUrl).toBe('http://kong-b:8100')
  })

  it('self-platform on + unregistered default: global client + SUPABASE_PUBLIC_URL', async () => {
    const mod = await loadModule('true')
    resolveProjectConnection.mockResolvedValueOnce({ row: null, supabaseUrl: '', serviceKey: '' })
    const ctx = await mod.getAdminContextForRef('default')
    expect(createClient).not.toHaveBeenCalled()
    expect(ctx.client).toBe(mod.selfHostedSupabaseAdmin)
    expect(ctx.publicBaseUrl).toBe('http://public-global:8000')
  })

  it('does not cache: two calls create two clients', async () => {
    const mod = await loadModule('true')
    resolveProjectConnection.mockResolvedValue({
      row: { id: 2 },
      supabaseUrl: 'http://kong-b:8100',
      serviceKey: 'service-b',
    })
    await mod.getAdminClientForRef('proj-b')
    await mod.getAdminClientForRef('proj-b')
    expect(createClient).toHaveBeenCalledTimes(2)
  })
})
