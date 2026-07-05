import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './index'
import { deleteProjectByRef } from '@/lib/api/self-platform/projects-admin'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
})

vi.mock('@/lib/api/self-platform/rbac/enforce', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  guardProjectRoute: vi.fn(),
  checkPermission: vi.fn(),
}))
vi.mock('@/lib/api/self-platform/projects-admin', () => ({ deleteProjectByRef: vi.fn() }))
// GET-path deps the module imports; DELETE tests never reach them.
vi.mock('@/lib/api/self-platform/resolve-connection', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveProjectConnection: vi.fn(),
}))

const claimsOf = (sub: string) => ({ sub }) as JwtPayload
const del = (ref: string | string[]) => createMocks({ method: 'DELETE', query: { ref } })

beforeEach(() => {
  vi.mocked(guardProjectRoute).mockReset().mockResolvedValue(true)
  vi.mocked(deleteProjectByRef).mockReset().mockResolvedValue(true)
})

describe('DELETE /platform/projects/[ref] (self-platform)', () => {
  it('happy path → guard(write:Delete, projects) then deregister, 200 {ref}', async () => {
    const { req, res } = del('team-a')
    await handler(req as never, res as never, claimsOf('g-owner'))
    expect(vi.mocked(guardProjectRoute).mock.calls[0][2]).toMatchObject({
      action: 'write:Delete',
      projectRef: 'team-a',
      resource: 'projects',
    })
    expect(deleteProjectByRef).toHaveBeenCalledWith('team-a')
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toEqual({ ref: 'team-a' })
  })

  it('guard denial short-circuits before the data layer', async () => {
    vi.mocked(guardProjectRoute).mockResolvedValue(false)
    const { req, res } = del('team-a')
    await handler(req as never, res as never, claimsOf('g-admin'))
    expect(deleteProjectByRef).not.toHaveBeenCalled()
  })

  it('default is refused AFTER the guard (no info leak), 400', async () => {
    const { req, res } = del('default')
    await handler(req as never, res as never, claimsOf('g-owner'))
    expect(guardProjectRoute).toHaveBeenCalled()
    expect(res._getStatusCode()).toBe(400)
    expect(res._getJSONData()).toEqual({ message: 'The default project cannot be deleted' })
    expect(deleteProjectByRef).not.toHaveBeenCalled()
  })

  it('array ref → 400 before the guard', async () => {
    const { req, res } = del(['a', 'b'])
    await handler(req as never, res as never, claimsOf('g-owner'))
    expect(res._getStatusCode()).toBe(400)
    expect(guardProjectRoute).not.toHaveBeenCalled()
  })

  it('unsupported method → 405 with Allow GET,DELETE', async () => {
    const { req, res } = createMocks({ method: 'PUT', query: { ref: 'x' } })
    await handler(req as never, res as never, claimsOf('g-1'))
    expect(res._getStatusCode()).toBe(405)
    // M6.1 added PATCH to the self-platform method set.
    expect(res._getHeaders().allow).toEqual(['GET', 'PATCH', 'DELETE'])
  })
})
