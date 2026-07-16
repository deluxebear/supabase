import { afterEach, describe, expect, it, vi } from 'vitest'

const { poolQuery } = vi.hoisted(() => ({ poolQuery: vi.fn() }))

vi.mock('pg', () => ({
  Pool: class MockPool {
    query = poolQuery
  },
  types: {
    builtins: { INT8: 20, TIMESTAMP: 1114, TIMESTAMPTZ: 1184 },
    setTypeParser: vi.fn(),
  },
}))

async function loadDb() {
  vi.resetModules()
  globalThis.selfPlatformPostgresPool = undefined
  vi.stubEnv('PLATFORM_POSTGRES_HOST', 'platform-db')
  vi.stubEnv('PLATFORM_POSTGRES_PORT', '5432')
  vi.stubEnv('PLATFORM_POSTGRES_DB', 'platform')
  vi.stubEnv('PLATFORM_POSTGRES_USER', 'postgres')
  vi.stubEnv('PLATFORM_POSTGRES_PASSWORD', 'pw123')
  return await import('./db')
}

afterEach(() => {
  vi.unstubAllEnvs()
  poolQuery.mockReset()
  globalThis.selfPlatformPostgresPool = undefined
})

describe('getPlatformConnectionString', () => {
  it('builds the connection string from PLATFORM_* env', async () => {
    const { getPlatformConnectionString } = await loadDb()
    expect(getPlatformConnectionString()).toBe(
      'postgresql://postgres:pw123@platform-db:5432/platform'
    )
  })
})

describe('executePlatformQuery', () => {
  it('executes parameterized SQL through the server-side PostgreSQL pool', async () => {
    poolQuery.mockResolvedValue({ rows: [{ ok: 1 }] })
    const { executePlatformQuery } = await loadDb()

    const { data, error } = await executePlatformQuery<{ ok: number }>({
      query: 'select 1 as ok where $1 = $1',
      parameters: ['x'],
    })

    expect(error).toBeUndefined()
    expect(data).toEqual([{ ok: 1 }])
    expect(poolQuery).toHaveBeenCalledWith('select 1 as ok where $1 = $1', ['x'])
  })

  it('returns an error tuple when PostgreSQL rejects the query', async () => {
    poolQuery.mockRejectedValue(new Error('boom'))
    const { executePlatformQuery } = await loadDb()
    const { data, error } = await executePlatformQuery({ query: 'select 1' })
    expect(data).toBeUndefined()
    expect(error?.message).toContain('boom')
  })

  it('returns non-Error PostgreSQL failures as thrown values', async () => {
    poolQuery.mockRejectedValue('connection closed')
    const { executePlatformQuery } = await loadDb()
    await expect(executePlatformQuery({ query: 'select 1' })).rejects.toBe('connection closed')
  })
})
