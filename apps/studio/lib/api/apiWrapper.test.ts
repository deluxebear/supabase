import { createMocks } from 'node-mocks-http'
import { afterEach, describe, expect, it, vi } from 'vitest'

import apiWrapper from './apiWrapper'

describe('apiWrapper error catchall', () => {
  it('returns 500 when a sync handler throws', async () => {
    const { req, res } = createMocks({ method: 'GET' })
    await apiWrapper(req as any, res as any, () => {
      throw new Error('sync boom')
    })
    expect(res._getStatusCode()).toBe(500)
  })

  it('returns 500 when an async handler rejects', async () => {
    const { req, res } = createMocks({ method: 'GET' })
    await apiWrapper(req as any, res as any, async () => {
      throw new Error('async boom')
    })
    expect(res._getStatusCode()).toBe(500)
  })
})

// [self-platform] C1: default-deny auth matrix. IS_PLATFORM / IS_SELF_PLATFORM
// are read from env at module load time, so each matrix cell needs a fresh
// module graph (vi.resetModules + dynamic import), matching the pattern used
// in lib/hosted-api-allowlist.test.ts.
async function loadApiWrapper(env: { isPlatform?: string; selfPlatform?: string }) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_IS_PLATFORM', env.isPlatform ?? '')
  vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', env.selfPlatform ?? '')
  const mod = await import('./apiWrapper')
  return mod.default
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('apiWrapper self-platform default-deny (C1)', () => {
  it('self-platform + no withAuth option + no Authorization header -> 401, handler not called', async () => {
    const wrapper = await loadApiWrapper({ isPlatform: 'true', selfPlatform: 'true' })
    const handler = vi.fn(async (_req: any, res: any) => res.status(200).json({ ok: true }))
    const { req, res } = createMocks({ method: 'GET' })
    await wrapper(req as any, res as any, handler)
    expect(res._getStatusCode()).toBe(401)
    expect(handler).not.toHaveBeenCalled()
  })

  it('self-platform + { withAuth: false } explicit opt-out -> runs unauthenticated', async () => {
    const wrapper = await loadApiWrapper({ isPlatform: 'true', selfPlatform: 'true' })
    const handler = vi.fn(async (_req: any, res: any) => res.status(200).json({ ok: true }))
    const { req, res } = createMocks({ method: 'GET' })
    await wrapper(req as any, res as any, handler, { withAuth: false })
    expect(res._getStatusCode()).toBe(200)
    expect(handler).toHaveBeenCalledOnce()
  })

  it('plain self-hosted (IS_PLATFORM false) + no options -> runs unauthenticated (unchanged)', async () => {
    const wrapper = await loadApiWrapper({ isPlatform: '', selfPlatform: '' })
    const handler = vi.fn(async (_req: any, res: any) => res.status(200).json({ ok: true }))
    const { req, res } = createMocks({ method: 'GET' })
    await wrapper(req as any, res as any, handler)
    expect(res._getStatusCode()).toBe(200)
    expect(handler).toHaveBeenCalledOnce()
  })

  it('real cloud (IS_PLATFORM true, SELF_PLATFORM false) + no options -> runs unauthenticated (unchanged)', async () => {
    const wrapper = await loadApiWrapper({ isPlatform: 'true', selfPlatform: '' })
    const handler = vi.fn(async (_req: any, res: any) => res.status(200).json({ ok: true }))
    const { req, res } = createMocks({ method: 'GET' })
    await wrapper(req as any, res as any, handler)
    expect(res._getStatusCode()).toBe(200)
    expect(handler).toHaveBeenCalledOnce()
  })

  it('self-platform + { withAuth: true } explicit opt-in + no Authorization header -> 401 (unchanged)', async () => {
    const wrapper = await loadApiWrapper({ isPlatform: 'true', selfPlatform: 'true' })
    const handler = vi.fn(async (_req: any, res: any) => res.status(200).json({ ok: true }))
    const { req, res } = createMocks({ method: 'GET' })
    await wrapper(req as any, res as any, handler, { withAuth: true })
    expect(res._getStatusCode()).toBe(401)
    expect(handler).not.toHaveBeenCalled()
  })
})
