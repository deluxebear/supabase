import { afterEach, describe, expect, it, vi } from 'vitest'

async function loadDb() {
  vi.resetModules()
  vi.stubEnv('PLATFORM_POSTGRES_HOST', 'platform-db')
  vi.stubEnv('PLATFORM_POSTGRES_PORT', '5432')
  vi.stubEnv('PLATFORM_POSTGRES_DB', 'platform')
  vi.stubEnv('PLATFORM_POSTGRES_USER', 'postgres')
  vi.stubEnv('PLATFORM_POSTGRES_PASSWORD', 'pw123')
  return await import('./db')
}

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
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
  it('POSTs to pg-meta /query with encrypted connection header and parameters', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify([{ ok: 1 }]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const { executePlatformQuery } = await loadDb()

    const { data, error } = await executePlatformQuery<{ ok: number }>({
      query: 'select 1 as ok where $1 = $1',
      parameters: ['x'],
    })

    expect(error).toBeUndefined()
    expect(data).toEqual([{ ok: 1 }])
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toMatch(/\/query$/)
    const headers = new Headers(init.headers)
    expect(headers.get('x-connection-encrypted')).toBeTruthy()
    expect(JSON.parse(init.body)).toEqual({
      query: 'select 1 as ok where $1 = $1',
      parameters: ['x'],
    })
  })

  it('returns error on non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: 'boom' }), { status: 500 }))
    )
    const { executePlatformQuery } = await loadDb()
    const { data, error } = await executePlatformQuery({ query: 'select 1' })
    expect(data).toBeUndefined()
    expect(error?.message).toContain('boom')
  })

  it('returns error tuple (does not throw) when the response body is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('<html>502 Bad Gateway</html>', { status: 502 }))
    )
    const { executePlatformQuery } = await loadDb()
    const { data, error } = await executePlatformQuery({ query: 'select 1' })
    expect(data).toBeUndefined()
    expect(error).toBeInstanceOf(Error)
  })
})
