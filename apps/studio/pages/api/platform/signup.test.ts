import { createMocks } from 'node-mocks-http'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { handler } from './signup'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})

afterEach(() => vi.unstubAllGlobals())

describe('POST /platform/signup (self-platform)', () => {
  it('forwards email/password to platform gotrue /signup', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ id: 'u1' }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const { req, res } = createMocks({
      method: 'POST',
      body: { email: 'a@b.c', password: 'pw', hcaptchaToken: null, redirectTo: '/' },
    })
    await handler(req as any, res as any)

    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toMatch(/\/signup$/)
    expect(JSON.parse(init.body)).toEqual({ email: 'a@b.c', password: 'pw' })
    expect(res._getStatusCode()).toBe(200)
  })

  it('maps gotrue errors onto { message } with original status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ code: 422, msg: 'User already registered' }), {
          status: 422,
        })
      )
    )
    const { req, res } = createMocks({
      method: 'POST',
      body: { email: 'a@b.c', password: 'pw', hcaptchaToken: null, redirectTo: '/' },
    })
    await handler(req as any, res as any)
    expect(res._getStatusCode()).toBe(422)
    expect(res._getJSONData()).toEqual({ message: 'User already registered' })
  })
})
