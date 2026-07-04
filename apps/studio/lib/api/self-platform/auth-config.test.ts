import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  DEFAULTS,
  readAuthConfig,
  SECRET_FIELDS,
  writeAuthConfig,
  writeHookConfig,
} from './auth-config'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})

const executePlatformQuery = vi.hoisted(() => vi.fn())
vi.mock('./db', () => ({ executePlatformQuery }))
vi.mock('./secrets', () => ({
  encryptSecret: vi.fn((s: string) => `enc:${s}`),
  decryptSecret: vi.fn(),
}))

beforeEach(() => {
  executePlatformQuery.mockReset()
})

describe('SECRET_FIELDS', () => {
  it('contains the 37 secret names and excludes lookalikes', () => {
    expect(SECRET_FIELDS.size).toBe(37)
    expect(SECRET_FIELDS.has('EXTERNAL_GITHUB_SECRET')).toBe(true)
    expect(SECRET_FIELDS.has('EXTERNAL_X_SECRET')).toBe(true)
    expect(SECRET_FIELDS.has('SMTP_PASS')).toBe(true)
    expect(SECRET_FIELDS.has('HOOK_SEND_EMAIL_SECRETS')).toBe(true)
    expect(SECRET_FIELDS.has('SMS_VONAGE_API_SECRET')).toBe(true)
    // exclusions
    expect(SECRET_FIELDS.has('SECURITY_UPDATE_PASSWORD_REQUIRE_CURRENT_PASSWORD')).toBe(false)
    expect(SECRET_FIELDS.has('SMS_TWILIO_ACCOUNT_SID')).toBe(false)
    expect(SECRET_FIELDS.has('PASSWORD_MIN_LENGTH')).toBe(false)
  })
})

describe('DEFAULTS', () => {
  it('is a complete GoTrueConfigResponse with known non-zero defaults and masked-blank secrets', () => {
    expect(DEFAULTS.JWT_EXP).toBe(3600)
    expect(DEFAULTS.DISABLE_SIGNUP).toBe(false)
    // every secret field defaults blank
    for (const k of SECRET_FIELDS) {
      if (k in DEFAULTS) expect((DEFAULTS as Record<string, unknown>)[k]).toBe('')
    }
  })
})

describe('readAuthConfig', () => {
  it('overlays stored config on DEFAULTS and masks every stored/known secret', async () => {
    executePlatformQuery.mockResolvedValue({
      data: [{ config: { DISABLE_SIGNUP: true }, secrets: { EXTERNAL_GITHUB_SECRET: 'enc:xyz' } }],
      error: undefined,
    })
    const cfg = await readAuthConfig('default')
    expect(cfg.DISABLE_SIGNUP).toBe(true) // stored override wins
    expect(cfg.JWT_EXP).toBe(3600) // default preserved
    expect(cfg.EXTERNAL_GITHUB_SECRET).toBe('') // masked, never decrypted
    expect(cfg.SMTP_PASS).toBe('') // masked
    // parameterized read
    expect(executePlatformQuery.mock.calls[0][0].parameters).toEqual(['default'])
  })

  it('returns DEFAULTS (secrets masked) when no row exists', async () => {
    executePlatformQuery.mockResolvedValue({ data: [], error: undefined })
    const cfg = await readAuthConfig('ghost')
    expect(cfg.DISABLE_SIGNUP).toBe(false)
    expect(cfg.EXTERNAL_GITHUB_SECRET).toBe('')
  })

  it('throws on a query error (fail-closed)', async () => {
    executePlatformQuery.mockResolvedValue({ data: undefined, error: new Error('boom') })
    await expect(readAuthConfig('default')).rejects.toThrow('boom')
  })
})

describe('writeAuthConfig', () => {
  it('splits secret/non-secret, encrypts secrets, skips blank secrets (no-overwrite)', async () => {
    // first call = upsert, second call = re-read
    executePlatformQuery
      .mockResolvedValueOnce({ data: [], error: undefined })
      .mockResolvedValueOnce({ data: [{ config: {}, secrets: {} }], error: undefined })
    await writeAuthConfig(
      'default',
      { DISABLE_SIGNUP: true, SMTP_PASS: 'newpass', EXTERNAL_GITHUB_SECRET: '' },
      'sub-1'
    )
    const upsert = executePlatformQuery.mock.calls[0][0]
    expect(upsert.query).toContain('insert into platform.auth_config')
    expect(upsert.parameters[0]).toBe('default')
    expect(JSON.parse(upsert.parameters[1])).toEqual({ DISABLE_SIGNUP: true }) // config patch
    expect(JSON.parse(upsert.parameters[2])).toEqual({ SMTP_PASS: 'enc:newpass' }) // encrypted; blank github secret dropped
    expect(upsert.parameters[3]).toBe('sub-1')
  })

  it('writes empty patches when only a masked secret arrives', async () => {
    executePlatformQuery
      .mockResolvedValueOnce({ data: [], error: undefined })
      .mockResolvedValueOnce({ data: [{ config: {}, secrets: {} }], error: undefined })
    await writeAuthConfig('default', { SMTP_PASS: '' })
    const upsert = executePlatformQuery.mock.calls[0][0]
    expect(JSON.parse(upsert.parameters[1])).toEqual({})
    expect(JSON.parse(upsert.parameters[2])).toEqual({})
  })
})

describe('writeHookConfig', () => {
  it('stores HOOK_* fields, encrypting the *_SECRETS one', async () => {
    executePlatformQuery
      .mockResolvedValueOnce({ data: [], error: undefined })
      .mockResolvedValueOnce({ data: [{ config: {}, secrets: {} }], error: undefined })
    await writeHookConfig(
      'default',
      { HOOK_SEND_EMAIL_ENABLED: true, HOOK_SEND_EMAIL_SECRETS: 's3cr3t' },
      'sub-9'
    )
    const upsert = executePlatformQuery.mock.calls[0][0]
    expect(JSON.parse(upsert.parameters[1])).toEqual({ HOOK_SEND_EMAIL_ENABLED: true })
    expect(JSON.parse(upsert.parameters[2])).toEqual({ HOOK_SEND_EMAIL_SECRETS: 'enc:s3cr3t' })
  })
})
