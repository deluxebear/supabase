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
  it('POSTs /invite with a service_role bearer and the /join redirect', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse())
    await sendInvitationEmail({ email: 'new@x.test', orgSlug: 'default', token: 'tok' })
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('http://gotrue.test/invite')
    expect((init!.headers as Record<string, string>).Authorization).toBe('Bearer minted.jwt')
    const body = JSON.parse(init!.body as string)
    expect(body.email).toBe('new@x.test')
    expect(body.redirect_to).toBe('http://studio.test/join?token=tok&slug=default')
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
    expect(url2).toBe('http://gotrue.test/otp')
    const body2 = JSON.parse(init2!.body as string)
    expect(body2.create_user).toBe(false)
    expect(body2.redirect_to).toBe('http://studio.test/join?token=tok&slug=default')
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
})
