import { beforeEach, describe, expect, it, vi } from 'vitest'

import { listOrganizationAuditLogs, toAuditLogEntry, type AuditEventRow } from './audit-logs'
import { executePlatformQuery } from './db'

vi.mock('./db', () => ({ executePlatformQuery: vi.fn() }))

const row: AuditEventRow = {
  id: 42,
  actor: '11111111-2222-3333-4444-555555555555',
  project_ref: 'project-d',
  action: 'fleet.configuration.commit',
  operation_id: 'op-1',
  correlation_id: 'corr-1',
  payload: { domain: 'auth' },
  created_at: '2026-09-30T15:58:58.677Z',
  actor_email: 'admin@internal.test',
}

describe('toAuditLogEntry', () => {
  it('maps an audit event onto the AuditLogsResponse entry shape', () => {
    expect(toAuditLogEntry(row, 'default')).toEqual({
      action: {
        name: 'fleet.configuration.commit',
        method: '',
        route: '',
        status: 200,
        metadata: { domain: 'auth' },
        params: { operation_id: 'op-1', correlation_id: 'corr-1' },
      },
      actor: {
        token_type: 'jwt',
        user_id: '11111111-2222-3333-4444-555555555555',
        email: 'admin@internal.test',
      },
      organization_slug: 'default',
      project_ref: 'project-d',
      request_id: 'audit-42',
      timestamp: Date.parse('2026-09-30T15:58:58.677Z') * 1000,
    })
  })

  it('falls back to empty metadata when the payload is null', () => {
    expect(toAuditLogEntry({ ...row, payload: null }, 'default').action.metadata).toEqual({})
  })
})

describe('listOrganizationAuditLogs', () => {
  beforeEach(() => vi.mocked(executePlatformQuery).mockReset())

  it('scopes to the org and time range, excludes Agent heartbeats, and maps rows', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({ data: [row], error: undefined })

    const response = await listOrganizationAuditLogs({
      orgId: 7,
      organizationSlug: 'default',
      start: '2026-09-30T00:00:00.000Z',
      end: '2026-10-01T00:00:00.000Z',
    })

    const call = vi.mocked(executePlatformQuery).mock.calls[0][0]
    expect(call.parameters).toEqual([
      7,
      '2026-09-30T00:00:00.000Z',
      '2026-10-01T00:00:00.000Z',
      ['fleet.management_binding.observe'],
    ])
    expect(call.query).toContain('pr.organization_id = $1')
    expect(response.result).toHaveLength(1)
    expect(response.result[0].request_id).toBe('audit-42')
  })

  it('rethrows query errors', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({
      data: undefined,
      error: new Error('boom'),
    })
    await expect(
      listOrganizationAuditLogs({ orgId: 7, organizationSlug: 'default', start: 'a', end: 'b' })
    ).rejects.toThrow('boom')
  })
})
