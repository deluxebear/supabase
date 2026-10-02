import { createMocks } from 'node-mocks-http'
import { afterEach, describe, expect, it, vi } from 'vitest'

const guardOrgRoute = vi.fn()
const listOrganizationAuditLogs = vi.fn()

vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardOrgRoute }))
vi.mock('@/lib/api/self-platform/audit-logs', () => ({ listOrganizationAuditLogs }))

async function loadHandler(selfPlatform: string) {
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', selfPlatform)
  return (await import('./audit')).handler
}

const query = {
  slug: 'default',
  iso_timestamp_start: '2026-10-01T15:19:59.000Z',
  iso_timestamp_end: '2026-10-02T15:19:59.000Z',
}

afterEach(() => {
  vi.unstubAllEnvs()
  guardOrgRoute.mockReset()
  listOrganizationAuditLogs.mockReset()
})

describe('org audit route — plain self-hosted (zero-break)', () => {
  it('returns 404', async () => {
    const handler = await loadHandler('')
    const { req, res } = createMocks({ method: 'GET', query })
    await handler(req as never, res as never, undefined)
    expect(res._getStatusCode()).toBe(404)
  })
})

describe('org audit route — self-platform', () => {
  it('returns the audit logs for the guarded org and time range', async () => {
    const handler = await loadHandler('true')
    guardOrgRoute.mockResolvedValue({ orgId: 7, orgSlug: 'default' })
    listOrganizationAuditLogs.mockResolvedValue({ result: [], retention_period: 0 })

    const { req, res } = createMocks({ method: 'GET', query })
    await handler(req as never, res as never, { sub: 'user' } as never)

    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toEqual({ result: [], retention_period: 0 })
    expect(listOrganizationAuditLogs).toHaveBeenCalledWith({
      orgId: 7,
      organizationSlug: 'default',
      start: '2026-10-01T15:19:59.000Z',
      end: '2026-10-02T15:19:59.000Z',
    })
  })

  it('rejects a missing or invalid time range before touching the database', async () => {
    const handler = await loadHandler('true')
    const { req, res } = createMocks({
      method: 'GET',
      query: { slug: 'default', iso_timestamp_start: 'nope' },
    })
    await handler(req as never, res as never, { sub: 'user' } as never)
    expect(res._getStatusCode()).toBe(400)
    expect(guardOrgRoute).not.toHaveBeenCalled()
  })

  it('stops when the org guard rejects the caller', async () => {
    const handler = await loadHandler('true')
    guardOrgRoute.mockImplementation(async (res) => {
      res.status(404).json({ message: 'Not found' })
      return null
    })
    const { req, res } = createMocks({ method: 'GET', query })
    await handler(req as never, res as never, { sub: 'user' } as never)
    expect(res._getStatusCode()).toBe(404)
    expect(listOrganizationAuditLogs).not.toHaveBeenCalled()
  })

  it('rejects non-GET methods', async () => {
    const handler = await loadHandler('true')
    const { req, res } = createMocks({ method: 'POST', query })
    await handler(req as never, res as never, { sub: 'user' } as never)
    expect(res._getStatusCode()).toBe(405)
  })
})
