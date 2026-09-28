import { beforeEach, describe, expect, it, vi } from 'vitest'

import { executePlatformQuery } from './db'
import {
  deleteFunctionSecrets,
  functionSecretInputSchema,
  isReservedFunctionSecretName,
  listFunctionSecretMetadata,
  readFunctionSecretValues,
  upsertFunctionSecrets,
} from './function-secrets'
import { encryptSecret } from './secrets'

vi.mock('./db', () => ({ executePlatformQuery: vi.fn() }))
vi.mock('./secrets', () => ({
  encryptSecret: vi.fn((value: string) => `encrypted:${value}`),
  decryptSecret: vi.fn((value: string) => value.replace(/^encrypted:/, '')),
}))

describe('Fleet function secrets', () => {
  beforeEach(() => {
    vi.mocked(executePlatformQuery).mockReset()
    vi.mocked(encryptSecret).mockClear()
  })

  it('lists metadata and digests without selecting ciphertext', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({
      data: [
        {
          name: 'OPENAI_API_KEY',
          value_digest: 'a'.repeat(64),
          updated_at: '2026-07-17T00:00:00.000Z',
        },
      ],
      error: undefined,
    })
    await expect(listFunctionSecretMetadata('project-a')).resolves.toEqual([
      {
        name: 'OPENAI_API_KEY',
        value: 'a'.repeat(64),
        updated_at: '2026-07-17T00:00:00.000Z',
      },
    ])
    expect(vi.mocked(executePlatformQuery).mock.calls[0]?.[0].query).not.toContain(
      'value_ciphertext,'
    )
  })

  it('encrypts write-only values and audits names without plaintext', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({ data: [], error: undefined })
    await upsertFunctionSecrets({
      projectRef: 'project-a',
      secrets: [{ name: 'OPENAI_API_KEY', value: 'super-secret-value' }],
      actor: 'operator',
      correlationId: 'request-a',
    })
    const call = vi.mocked(executePlatformQuery).mock.calls[0]?.[0]
    expect(call.parameters?.[1]).toContain('encrypted:super-secret-value')
    expect(call.parameters?.[1]).not.toContain('"value":"super-secret-value"')
    expect(call.query).toContain('fleet.function.secret.upsert')
    expect(encryptSecret).toHaveBeenCalledWith('super-secret-value')
  })

  it('rejects duplicate names before storage and deletes only project-scoped names', async () => {
    await expect(
      upsertFunctionSecrets({
        projectRef: 'project-a',
        secrets: [
          { name: 'TOKEN', value: 'one' },
          { name: 'TOKEN', value: 'two' },
        ],
        actor: 'operator',
        correlationId: 'request-a',
      })
    ).rejects.toThrow('unique')
    expect(executePlatformQuery).not.toHaveBeenCalled()

    vi.mocked(executePlatformQuery).mockResolvedValue({ data: [], error: undefined })
    await deleteFunctionSecrets({
      projectRef: 'project-a',
      names: ['TOKEN'],
      actor: 'operator',
      correlationId: 'request-b',
    })
    expect(vi.mocked(executePlatformQuery).mock.calls[0]?.[0].parameters).toEqual([
      'project-a',
      ['TOKEN'],
      'operator',
      'request-b',
    ])
  })

  it('rejects names reserved by the Edge Functions runtime', () => {
    for (const name of ['SUPABASE_URL', 'supabase_url', 'JWT_SECRET', 'VERIFY_JWT', 'DENO_DIR']) {
      expect(isReservedFunctionSecretName(name)).toBe(true)
      expect(functionSecretInputSchema.safeParse({ name, value: 'x' }).success).toBe(false)
    }
    for (const name of ['STRIPE_KEY', 'MY_SUPABASE_URL', 'jwt']) {
      expect(isReservedFunctionSecretName(name)).toBe(false)
      expect(functionSecretInputSchema.safeParse({ name, value: 'x' }).success).toBe(true)
    }
  })

  it('decrypts stored values for sealing', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({
      data: [{ name: 'STRIPE_KEY', value_ciphertext: 'encrypted:sk_test' }],
      error: undefined,
    })
    await expect(readFunctionSecretValues('project-a')).resolves.toEqual({
      STRIPE_KEY: 'sk_test',
    })
    expect(vi.mocked(executePlatformQuery).mock.calls[0]?.[0].parameters).toEqual(['project-a'])
  })
})
