import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { mutateManagedAPIKeys } from './api-key-management'
import { handleManagedAPIKeyMutation } from './api-key-route'
import { guardProjectRoute } from './rbac/enforce'
import { hasRecentAal2 } from './recent-aal2'
import { ServiceConfigApplyConflict } from './service-config-apply'

vi.mock('./api-key-management', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  mutateManagedAPIKeys: vi.fn(),
}))
vi.mock('./rbac/enforce', () => ({ guardProjectRoute: vi.fn() }))
vi.mock('./recent-aal2', () => ({ hasRecentAal2: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(guardProjectRoute).mockResolvedValue(true)
  vi.mocked(hasRecentAal2).mockReturnValue(true)
  vi.mocked(mutateManagedAPIKeys).mockResolvedValue({
    id: 'test',
    type: 'secret',
    name: 'server',
    description: '',
    api_key: 'sb_secret_hiddenvalue',
    hash: '',
    prefix: 'sb_secret_hidde',
  })
})

async function call(
  method: 'POST' | 'PATCH' | 'DELETE',
  body: Record<string, unknown> | undefined,
  headers: Record<string, string> = { 'idempotency-key': 'test-request' }
) {
  const { req, res } = createMocks({
    method,
    query: { ref: 'project-d', id: 'test', reveal: 'false' },
    headers,
    body,
  })
  await handleManagedAPIKeyMutation(req, res, {
    sub: 'owner',
    aal: 'aal2',
    iat: Math.floor(Date.now() / 1000),
  } as never)
  return res
}

describe('Fleet API key mutation routes', () => {
  it('checks secret-read and infrastructure permissions before creating a key', async () => {
    const res = await call('POST', {
      name: 'server',
      type: 'secret',
      secret_jwt_template: { role: 'service_role' },
    })
    expect(res.statusCode).toBe(201)
    expect(guardProjectRoute).toHaveBeenCalledTimes(2)
    expect(res._getJSONData().api_key).toBe('sb_secret_hidde')
    expect(mutateManagedAPIKeys).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRef: 'project-d',
        idempotencyKey: 'test-request',
        change: {
          kind: 'create',
          input: { name: 'server', type: 'secret', secret_jwt_template: { role: 'service_role' } },
        },
      })
    )
  })
  it('does not mutate without infrastructure permission', async () => {
    vi.mocked(guardProjectRoute).mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    await call('POST', { name: 'browser', type: 'publishable' })
    expect(mutateManagedAPIKeys).not.toHaveBeenCalled()
  })
  it('requires recent AAL2, idempotency and a fixed service role', async () => {
    vi.mocked(hasRecentAal2).mockReturnValueOnce(false)
    expect((await call('POST', { name: 'server', type: 'secret' })).statusCode).toBe(403)
    expect((await call('POST', { name: 'server', type: 'secret' }, {})).statusCode).toBe(400)
    expect(
      (
        await call('POST', {
          name: 'server',
          type: 'secret',
          secret_jwt_template: { role: 'postgres' },
        })
      ).statusCode
    ).toBe(400)
    expect(mutateManagedAPIKeys).not.toHaveBeenCalled()
  })
  it('routes deletion and metadata editing through the same coordinated Agent apply', async () => {
    expect((await call('DELETE', undefined)).statusCode).toBe(200)
    expect(mutateManagedAPIKeys).toHaveBeenLastCalledWith(
      expect.objectContaining({ change: { kind: 'delete', id: 'test' } })
    )
    expect((await call('PATCH', { name: 'renamed' })).statusCode).toBe(200)
    expect(mutateManagedAPIKeys).toHaveBeenLastCalledWith(
      expect.objectContaining({
        change: { kind: 'update', id: 'test', input: { name: 'renamed' } },
      })
    )
  })
  it('reports an Agent rollout failure instead of returning a usable credential', async () => {
    vi.mocked(mutateManagedAPIKeys).mockRejectedValue(
      new ServiceConfigApplyConflict('apply_unavailable', 'Gateway rollout failed')
    )
    const res = await call('POST', { name: 'server', type: 'secret' })
    expect(res.statusCode).toBe(409)
    expect(res._getJSONData()).toEqual({
      code: 'apply_unavailable',
      message: 'Gateway rollout failed',
    })
  })
})
