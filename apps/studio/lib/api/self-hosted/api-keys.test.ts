import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getNonPlatformApiKeys, parseRevealQuery } from './api-keys'

vi.mock('./util', () => ({
  assertSelfHosted: vi.fn(),
}))

describe('api/self-hosted/api-keys', () => {
  let mockAssertSelfHosted: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.resetModules()
    vi.unstubAllEnvs()

    const util = await import('./util')
    mockAssertSelfHosted = vi.mocked(util.assertSelfHosted)
  })

  describe('getNonPlatformApiKeys (no arg / global env — M1 parity)', () => {
    it('should call assertSelfHosted', () => {
      getNonPlatformApiKeys()

      expect(mockAssertSelfHosted).toHaveBeenCalled()
    })

    it('returns only the two legacy keys when no new-key env vars are set', () => {
      vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key-value')
      vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-key-value')
      vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', '')
      vi.stubEnv('SUPABASE_SECRET_KEY', '')

      const keys = getNonPlatformApiKeys()

      expect(keys).toHaveLength(2)
      expect(keys[0]).toMatchObject({
        name: 'anon',
        id: 'anon',
        type: 'legacy',
        api_key: 'anon-key-value',
      })
      expect(keys[1]).toMatchObject({
        name: 'service_role',
        id: 'service_role',
        type: 'legacy',
        api_key: 'service-key-value',
      })
    })

    it('falls back to empty strings when legacy env vars are unset', () => {
      vi.stubEnv('SUPABASE_ANON_KEY', '')
      vi.stubEnv('SUPABASE_SERVICE_KEY', '')
      vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', '')
      vi.stubEnv('SUPABASE_SECRET_KEY', '')

      const keys = getNonPlatformApiKeys()

      expect(keys[0].api_key).toBe('')
      expect(keys[1].api_key).toBe('')
    })

    it('appends a publishable entry when SUPABASE_PUBLISHABLE_KEY is set', () => {
      vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key-value')
      vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-key-value')
      vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_abc')
      vi.stubEnv('SUPABASE_SECRET_KEY', '')

      const keys = getNonPlatformApiKeys()

      expect(keys).toHaveLength(3)
      expect(keys[2]).toEqual({
        name: 'publishable',
        api_key: 'sb_publishable_abc',
        id: 'publishable',
        type: 'publishable',
        hash: '',
        prefix: '',
        description: 'Publishable API key (anon role)',
      })
      expect(keys.find((k) => k.type === 'secret')).toBeUndefined()
    })

    it('appends a secret entry when SUPABASE_SECRET_KEY is set', () => {
      vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key-value')
      vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-key-value')
      vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', '')
      vi.stubEnv('SUPABASE_SECRET_KEY', 'sb_secret_abcdefghijklmnop')

      const keys = getNonPlatformApiKeys()

      expect(keys).toHaveLength(3)
      expect(keys[2]).toEqual({
        name: 'secret',
        api_key: 'sb_secret_abcdefghijklmnop',
        id: 'secret',
        type: 'secret',
        hash: '',
        prefix: 'sb_secret_abcde',
        description: 'Secret API key (service_role)',
      })
      expect(keys.find((k) => k.type === 'publishable')).toBeUndefined()
    })

    it('appends both new entries when both env vars are set, in publishable-then-secret order', () => {
      vi.stubEnv('SUPABASE_ANON_KEY', 'anon-key-value')
      vi.stubEnv('SUPABASE_SERVICE_KEY', 'service-key-value')
      vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_abc')
      vi.stubEnv('SUPABASE_SECRET_KEY', 'sb_secret_abcdefghijklmnop')

      const keys = getNonPlatformApiKeys()

      expect(keys).toHaveLength(4)
      expect(keys.map((k) => k.id)).toEqual(['anon', 'service_role', 'publishable', 'secret'])
    })
  })

  // [self-platform] resolved-connection branch — self-platform multi-project.
  describe('getNonPlatformApiKeys with resolved connection', () => {
    it('uses resolved project keys when provided', () => {
      // Global env set to different values to prove the resolved branch does
      // not fall through to them.
      vi.stubEnv('SUPABASE_ANON_KEY', 'global-anon')
      vi.stubEnv('SUPABASE_SERVICE_KEY', 'global-service')

      const keys = getNonPlatformApiKeys({
        anonKey: 'ANON-B',
        serviceKey: 'SVC-B',
        publishableKey: null,
        secretKey: null,
      })

      expect(keys).toHaveLength(2)
      expect(keys[0]).toMatchObject({ name: 'anon', id: 'anon', api_key: 'ANON-B' })
      expect(keys[1]).toMatchObject({
        name: 'service_role',
        id: 'service_role',
        api_key: 'SVC-B',
      })
    })

    it('appends resolved publishable and secret keys when present', () => {
      const keys = getNonPlatformApiKeys({
        anonKey: 'ANON-B',
        serviceKey: 'SVC-B',
        publishableKey: 'sb_publishable_b',
        secretKey: 'sb_secret_b_abcdefghijklmnop',
      })

      expect(keys).toHaveLength(4)
      expect(keys[2]).toMatchObject({
        name: 'publishable',
        api_key: 'sb_publishable_b',
        type: 'publishable',
      })
      expect(keys[3]).toMatchObject({
        name: 'secret',
        api_key: 'sb_secret_b_abcdefghijklmnop',
        type: 'secret',
        prefix: 'sb_secret_b_abc',
      })
    })

    it('still calls assertSelfHosted when resolved is provided', () => {
      getNonPlatformApiKeys({
        anonKey: 'ANON-B',
        serviceKey: 'SVC-B',
        publishableKey: null,
        secretKey: null,
      })

      expect(mockAssertSelfHosted).toHaveBeenCalled()
    })

    it('does not expose global env keys when resolved project has null publishable/secret keys', () => {
      // Global env is set to non-empty values to test isolation.
      vi.stubEnv('SUPABASE_ANON_KEY', 'global-anon')
      vi.stubEnv('SUPABASE_SERVICE_KEY', 'global-service')
      vi.stubEnv('SUPABASE_PUBLISHABLE_KEY', 'GLOBAL_PUB')
      vi.stubEnv('SUPABASE_SECRET_KEY', 'GLOBAL_SEC')

      const keys = getNonPlatformApiKeys({
        anonKey: 'PROJECT-ANON',
        serviceKey: 'PROJECT-SERVICE',
        publishableKey: null,
        secretKey: null,
      })

      // Should only have the two legacy keys from resolved project, not global publishable/secret
      expect(keys).toHaveLength(2)
      expect(keys.map((k) => k.api_key)).not.toContain('GLOBAL_PUB')
      expect(keys.map((k) => k.api_key)).not.toContain('GLOBAL_SEC')
      expect(keys[0]).toMatchObject({
        name: 'anon',
        api_key: 'PROJECT-ANON',
      })
      expect(keys[1]).toMatchObject({
        name: 'service_role',
        api_key: 'PROJECT-SERVICE',
      })
    })
  })

  describe('parseRevealQuery', () => {
    it('returns true only for the literal string "true"', () => {
      expect(parseRevealQuery('true')).toBe(true)
      expect(parseRevealQuery('false')).toBe(false)
      expect(parseRevealQuery(undefined)).toBe(false)
      expect(parseRevealQuery(['true', 'false'])).toBe(true)
    })
  })
})
