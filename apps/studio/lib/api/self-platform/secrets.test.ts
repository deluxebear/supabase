import { afterEach, describe, expect, it, vi } from 'vitest'

async function load(key: string | undefined) {
  vi.resetModules()
  if (key === undefined) vi.stubEnv('PLATFORM_ENCRYPTION_KEY', '')
  else vi.stubEnv('PLATFORM_ENCRYPTION_KEY', key)
  return await import('./secrets')
}

afterEach(() => vi.unstubAllEnvs())

describe('encryptSecret/decryptSecret', () => {
  it('round-trips a secret', async () => {
    const { encryptSecret, decryptSecret } = await load('unit-test-key-32-characters-long!!')
    const enc = encryptSecret('super-secret-service-key')
    expect(enc).not.toBe('super-secret-service-key')
    expect(decryptSecret(enc)).toBe('super-secret-service-key')
  })

  it('throws on encrypt when key is missing', async () => {
    const { encryptSecret } = await load(undefined)
    expect(() => encryptSecret('x')).toThrow('PLATFORM_ENCRYPTION_KEY is not set')
  })

  it('throws on decrypt of garbage / wrong key', async () => {
    const { decryptSecret } = await load('unit-test-key-32-characters-long!!')
    expect(() => decryptSecret('not-valid-ciphertext')).toThrow('failed to decrypt platform secret')
  })
})
