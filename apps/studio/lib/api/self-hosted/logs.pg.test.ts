import { afterEach, describe, expect, it, vi } from 'vitest'

import { retrieveAnalyticsData } from './logs'

vi.mock('./util', () => ({ assertSelfHosted: vi.fn() }))
vi.mock('@/lib/constants/self-platform', () => ({ IS_SELF_PLATFORM: true }))
vi.mock('@/lib/api/self-platform/resolve-connection', () => ({
  resolveProjectConnection: vi.fn(async (_input: URL) => ({
    row: {},
    ref: 'project-d',
    logflareUrl: 'http://project-d-analytics:4000',
    logflareToken: 'private-test',
  })),
}))

afterEach(() => vi.unstubAllGlobals())

describe('self-hosted unified logs transport', () => {
  it('uses the registered project PG query API and restores envelopes', async () => {
    const fetch = vi.fn(async (_input: URL) =>
      Response.json({
        result: [
          {
            id: 'id',
            timestamp: 1790726400000000,
            event_message:
              'UnifiedLog | edge | 200 | success | GET | /rest/v1/test |  | ' +
              JSON.stringify({
                event_message: 'request',
                metadata: { request: { method: 'GET' } },
              }),
          },
        ],
      })
    )
    vi.stubGlobal('fetch', fetch)
    const sql = '-- self-hosted unified logs\nSELECT id FROM unified_logs LIMIT 1'
    const { data, error } = await retrieveAnalyticsData({
      name: 'logs.all',
      projectRef: 'project-d',
      params: { sql },
    })
    expect(error).toBeUndefined()
    const url = new URL(fetch.mock.calls[0][0])
    expect(url.origin).toBe('http://project-d-analytics:4000')
    expect(url.pathname).toBe('/api/query')
    expect(url.searchParams.get('pg_sql')).toBe(sql)
    expect(data?.result?.[0]).toMatchObject({
      event_message: 'request',
      log_type: 'edge',
      self_hosted: true,
    })
  })
  it('keeps legacy queries on the seeded endpoint and propagates backend errors', async () => {
    const fetch = vi.fn(async (_input: URL) => Response.json({ error: 'Unknown table' }))
    vi.stubGlobal('fetch', fetch)
    const { error } = await retrieveAnalyticsData({
      name: 'logs.all',
      projectRef: 'project-d',
      params: { sql: 'SELECT id FROM edge_logs LIMIT 1' },
    })
    expect(new URL(fetch.mock.calls[0][0]).pathname).toBe('/api/endpoints/query/logs.all')
    expect(error?.message).toBe('Unknown table')
  })
})
