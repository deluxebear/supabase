import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { findProjectEndpointRegistryForFunctionUrl } from '@/lib/api/self-platform/endpoint-registry'

vi.mock('common', () => ({ IS_PLATFORM: true }))
vi.mock('@/lib/constants/self-platform', () => ({ IS_SELF_PLATFORM: true }))
vi.mock('@/lib/api/self-platform/endpoint-registry', () => ({
  findProjectEndpointRegistryForFunctionUrl: vi.fn(),
}))

const functionUrl = 'http://192.168.50.149:8300/functions/v1/p1-6-acceptance'

beforeEach(() => {
  vi.mocked(findProjectEndpointRegistryForFunctionUrl).mockReset().mockResolvedValue({
    revision: 1,
    endpoints: { functionsUrl: 'http://192.168.50.149:8300/functions/v1' } as never,
  })
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
  )
})

describe('Fleet Edge Function tester API', () => {
  it('forwards a registered self-platform function URL', async () => {
    const { default: handler } = await import('@/pages/api/edge-functions/test')
    const { req, res } = createMocks({
      method: 'POST',
      body: {
        url: functionUrl,
        method: 'POST',
        body: '{"name":"Functions"}',
        headers: { 'Content-Type': 'application/json' },
      },
    })

    await handler(req as never, res as never)

    expect(res._getStatusCode()).toBe(200)
    expect(findProjectEndpointRegistryForFunctionUrl).toHaveBeenCalledWith(functionUrl)
    expect(fetch).toHaveBeenCalledWith(
      functionUrl,
      expect.objectContaining({ method: 'POST', body: '{"name":"Functions"}' })
    )
  })

  it('rejects a URL that is not registered to a Fleet project', async () => {
    vi.mocked(findProjectEndpointRegistryForFunctionUrl).mockResolvedValueOnce(null)
    const { default: handler } = await import('@/pages/api/edge-functions/test')
    const { req, res } = createMocks({
      method: 'POST',
      body: { url: functionUrl, method: 'POST', body: '{}', headers: {} },
    })

    await handler(req as never, res as never)

    expect(res._getStatusCode()).toBe(400)
    expect(fetch).not.toHaveBeenCalled()
  })
})
