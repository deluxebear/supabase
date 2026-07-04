import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sendInvitationEmail } from './invite-email'

vi.mock('./constants', () => ({
  PLATFORM_GOTRUE_URL: 'http://gotrue.test',
  PLATFORM_JWT_SECRET: 'secret',
  PLATFORM_SITE_URL: 'http://studio.test',
}))
vi.mock('./mint-jwt', () => ({ mintServiceJwt: vi.fn(() => 'minted.jwt') }))

const okResponse = () => ({ ok: true, status: 200, json: async () => ({}) }) as Response

beforeEach(() => vi.restoreAllMocks())
afterEach(() => vi.restoreAllMocks())

describe('sendInvitationEmail', () => {
  it('POSTs /invite with a service_role bearer and redirect_to as a URL query param', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse())
    await sendInvitationEmail({ email: 'new@x.test', orgSlug: 'default', token: 'tok' })
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url as string).toMatch(/^http:\/\/gotrue\.test\/invite\?redirect_to=/)
    const redirectParam = (url as string).split('redirect_to=')[1]
    expect(decodeURIComponent(redirectParam)).toBe('http://studio.test/join?token=tok&slug=default')
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer minted.jwt')
    const body = JSON.parse(init!.body as string)
    expect(body.email).toBe('new@x.test')
    expect(body.data).toEqual({ org_slug: 'default' })
    expect(body.redirect_to).toBeUndefined()
  })

  it('falls back to /otp magiclink when /invite reports already-registered', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: false,
        status: 422,
        json: async () => ({ error_code: 'email_exists' }),
      } as Response)
      .mockResolvedValueOnce(okResponse())
    await sendInvitationEmail({ email: 'existing@x.test', orgSlug: 'default', token: 'tok' })
    expect(fetchSpy).toHaveBeenCalledTimes(2)
    const [url2, init2] = fetchSpy.mock.calls[1]
    expect(url2 as string).toMatch(/^http:\/\/gotrue\.test\/otp\?redirect_to=/)
    const redirectParam2 = (url2 as string).split('redirect_to=')[1]
    expect(decodeURIComponent(redirectParam2)).toBe(
      'http://studio.test/join?token=tok&slug=default'
    )
    const body2 = JSON.parse(init2!.body as string)
    expect(body2.create_user).toBe(false)
    expect(body2.redirect_to).toBeUndefined()
  })

  it('throws when both paths fail (so the create route rolls back the row)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ msg: 'smtp down' }),
    } as Response)
    await expect(
      sendInvitationEmail({ email: 'x@x.test', orgSlug: 'default', token: 'tok' })
    ).rejects.toThrow()
  })

  it('throws when /invite is already-registered but the /otp fallback also fails', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({
        ok: false,
        status: 422,
        json: async () => ({ error_code: 'email_exists' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ msg: 'smtp down' }),
      } as Response)
    await expect(
      sendInvitationEmail({ email: 'existing@x.test', orgSlug: 'default', token: 'tok' })
    ).rejects.toThrow()
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})
