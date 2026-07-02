import { afterEach, describe, expect, it, vi } from 'vitest'

// Mock crypto-js for encryptString tests
vi.mock('crypto-js', () => {
  const mockEncrypt = vi.fn()
  return {
    default: {
      AES: {
        encrypt: mockEncrypt,
      },
    },
    AES: {
      encrypt: mockEncrypt,
    },
  }
})

async function loadUtil(env: { isPlatform: string; selfPlatform: string }) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_IS_PLATFORM', env.isPlatform)
  vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', env.selfPlatform)
  return await import('./util')
}

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('assertSelfHosted', () => {
  it('passes in plain self-hosted mode', async () => {
    const { assertSelfHosted } = await loadUtil({ isPlatform: 'false', selfPlatform: '' })
    expect(() => assertSelfHosted()).not.toThrow()
  })

  it('throws in platform mode without self-platform', async () => {
    const { assertSelfHosted } = await loadUtil({ isPlatform: 'true', selfPlatform: '' })
    expect(() => assertSelfHosted()).toThrow(
      'This function can only be called in self-hosted environments'
    )
  })

  it('passes in self-platform mode', async () => {
    const { assertSelfHosted } = await loadUtil({ isPlatform: 'true', selfPlatform: 'true' })
    expect(() => assertSelfHosted()).not.toThrow()
  })
})

describe('encryptString', () => {
  it('should encrypt string using AES', async () => {
    const { encryptString } = await loadUtil({ isPlatform: 'false', selfPlatform: '' })
    const crypto = await import('crypto-js')
    const mockEncrypted = 'encrypted-string-123'
    vi.mocked(crypto.default.AES.encrypt).mockReturnValue({
      toString: () => mockEncrypted,
    } as any)

    const result = encryptString('my-secret-data')

    expect(crypto.default.AES.encrypt).toHaveBeenCalledWith('my-secret-data', expect.any(String))
    expect(result).toBe(mockEncrypted)
  })

  it('should return encrypted string as string', async () => {
    const { encryptString } = await loadUtil({ isPlatform: 'false', selfPlatform: '' })
    const crypto = await import('crypto-js')
    vi.mocked(crypto.default.AES.encrypt).mockReturnValue({
      toString: () => 'U2FsdGVkX1+abc123',
    } as any)

    const result = encryptString('test')

    expect(typeof result).toBe('string')
    expect(result).toBe('U2FsdGVkX1+abc123')
  })
})

describe('getConnectionString', () => {
  it('should build connection string with read-write user', async () => {
    vi.resetModules()
    vi.stubEnv('POSTGRES_HOST', 'localhost')
    vi.stubEnv('POSTGRES_PORT', '5432')
    vi.stubEnv('POSTGRES_DB', 'testdb')
    vi.stubEnv('POSTGRES_PASSWORD', 'testpass')
    vi.stubEnv('POSTGRES_USER_READ_WRITE', 'admin_user')

    const { getConnectionString } = await import('./util')

    const result = getConnectionString({ readOnly: false })

    expect(result).toBe('postgresql://admin_user:testpass@localhost:5432/testdb')
  })

  it('should build connection string with read-only user', async () => {
    vi.resetModules()
    vi.stubEnv('POSTGRES_HOST', 'db.example.com')
    vi.stubEnv('POSTGRES_PORT', '5433')
    vi.stubEnv('POSTGRES_DB', 'mydb')
    vi.stubEnv('POSTGRES_PASSWORD', 'secret')
    vi.stubEnv('POSTGRES_USER_READ_ONLY', 'readonly_user')

    const { getConnectionString } = await import('./util')

    const result = getConnectionString({ readOnly: true })

    expect(result).toBe('postgresql://readonly_user:secret@db.example.com:5433/mydb')
  })

  it('should use default values when env vars not set', async () => {
    vi.resetModules()
    vi.stubEnv('POSTGRES_HOST', '')
    vi.stubEnv('POSTGRES_PORT', '')
    vi.stubEnv('POSTGRES_DB', '')
    vi.stubEnv('POSTGRES_PASSWORD', '')
    vi.stubEnv('POSTGRES_USER_READ_WRITE', '')
    vi.stubEnv('POSTGRES_USER_READ_ONLY', '')

    const { getConnectionString } = await import('./util')

    const resultReadWrite = getConnectionString({ readOnly: false })
    const resultReadOnly = getConnectionString({ readOnly: true })

    expect(resultReadWrite).toBe('postgresql://supabase_admin:postgres@db:5432/postgres')
    expect(resultReadOnly).toBe('postgresql://supabase_read_only_user:postgres@db:5432/postgres')
  })
})
