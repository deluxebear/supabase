import * as supabaseJs from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { createProjectSupabaseClient } from './project-supabase-client'
import * as apiKeysUtils from '@/data/api-keys/temp-api-keys-utils'
import { addAPIMock } from '@/tests/lib/msw'

vi.mock('@/lib/constants/self-platform', () => ({ IS_SELF_PLATFORM: true }))

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(),
}))

vi.mock('@/data/api-keys/temp-api-keys-utils', () => ({
  getOrRefreshTemporaryApiKey: vi.fn(),
}))

const TEMP_JWT = 'eyJhbGciOiJIUzI1NiJ9.service-role.signature'

describe('createProjectSupabaseClient on self-platform', () => {
  beforeEach(() => {
    vi.mocked(supabaseJs.createClient).mockReset()
    vi.mocked(apiKeysUtils.getOrRefreshTemporaryApiKey).mockResolvedValue({
      apiKey: TEMP_JWT,
      expiryTimeMs: Date.now() + 3600000,
    })
  })

  it('sends a publishable key as apikey and the temporary JWT as the bearer token', async () => {
    addAPIMock({
      method: 'get',
      path: '/v1/projects/:ref/api-keys',
      response: [
        { name: 'anon', api_key: 'legacy-anon-jwt', type: 'legacy' },
        { name: 'default', api_key: 'sb_publishable_abc', type: 'publishable', id: 'p1' },
      ],
    })

    await createProjectSupabaseClient('project-d', 'http://gateway')

    const [endpoint, key, options] = vi.mocked(supabaseJs.createClient).mock.calls[0]
    expect(endpoint).toBe('http://gateway')
    expect(key).toBe('sb_publishable_abc')
    expect(options?.global?.headers).toEqual({ Authorization: `Bearer ${TEMP_JWT}` })
  })

  it('falls back to the legacy anon key when there is no publishable key', async () => {
    addAPIMock({
      method: 'get',
      path: '/v1/projects/:ref/api-keys',
      response: [{ name: 'anon', api_key: 'legacy-anon-jwt', type: 'legacy' }],
    })

    await createProjectSupabaseClient('project-d', 'http://gateway')

    const [, key, options] = vi.mocked(supabaseJs.createClient).mock.calls[0]
    expect(key).toBe('legacy-anon-jwt')
    expect(options?.global?.headers).toEqual({ Authorization: `Bearer ${TEMP_JWT}` })
  })
})
