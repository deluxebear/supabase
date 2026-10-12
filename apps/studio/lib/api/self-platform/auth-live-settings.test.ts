import { describe, expect, it, vi } from 'vitest'

import { mapLiveAuthSettings, readLiveAuthSettings } from './auth-live-settings'

vi.mock('./resolve-connection', () => ({
  resolveProjectConnection: vi
    .fn()
    .mockResolvedValue({ supabaseUrl: 'http://gateway:8000/', anonKey: 'anon' }),
}))

const settings = {
  external: { email: true, phone: true, github: false, linkedin_oidc: true, unknown_x: true },
  disable_signup: false,
  mailer_autoconfirm: false,
  phone_autoconfirm: true,
  sms_provider: '',
  saml_enabled: false,
  passkeys_enabled: false,
}

describe('live Auth settings', () => {
  it('maps GoTrue settings to known config fields', () => {
    expect(mapLiveAuthSettings(settings)).toEqual({
      DISABLE_SIGNUP: false,
      MAILER_AUTOCONFIRM: false,
      SMS_AUTOCONFIRM: true,
      SAML_ENABLED: false,
      PASSKEY_ENABLED: false,
      EXTERNAL_EMAIL_ENABLED: true,
      EXTERNAL_PHONE_ENABLED: true,
      EXTERNAL_GITHUB_ENABLED: false,
      EXTERNAL_LINKEDIN_OIDC_ENABLED: true,
    })
    expect(mapLiveAuthSettings({ sms_provider: 'twilio' })).toEqual({ SMS_PROVIDER: 'twilio' })
    expect(mapLiveAuthSettings('not settings')).toEqual({})
  })

  it('reads the project gateway with the anon key', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json(settings))
    const live = await readLiveAuthSettings('project-a', fetchImpl)
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://gateway:8000/auth/v1/settings',
      expect.objectContaining({ headers: { apikey: 'anon' } })
    )
    expect(live.SMS_AUTOCONFIRM).toBe(true)
  })

  it('falls back to no live values when Auth is unreachable', async () => {
    expect(
      await readLiveAuthSettings('project-a', vi.fn().mockRejectedValue(new Error('down')))
    ).toEqual({})
    expect(
      await readLiveAuthSettings(
        'project-a',
        vi.fn().mockResolvedValue(new Response('', { status: 503 }))
      )
    ).toEqual({})
  })
})
