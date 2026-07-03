import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './roles'
import { guardOrgRoute } from '@/lib/api/self-platform/rbac/enforce'
import { listRolesV2 } from '@/lib/api/self-platform/roles'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})

vi.mock('@/lib/api/self-platform/roles', () => ({ listRolesV2: vi.fn() }))
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardOrgRoute: vi.fn() }))

const claimsOf = (sub: string) => ({ sub }) as JwtPayload

beforeEach(() => {
  vi.mocked(guardOrgRoute).mockReset()
  vi.mocked(listRolesV2).mockReset()
})

describe('GET /platform/organizations/{slug}/roles (self-platform)', () => {
  const ROLES = {
    org_scoped_roles: [{ id: 1, base_role_id: 1, name: 'Owner', description: null, projects: [] }],
    project_scoped_roles: [
      {
        id: 7,
        base_role_id: 3,
        name: 'Developer-scoped-x',
        description: null,
        projects: [{ name: 'Project B', ref: 'proj-b' }],
      },
    ],
  }

  it('returns the dual-layer V2 shape regardless of Version header form', async () => {
    vi.mocked(guardOrgRoute).mockResolvedValue({ orgId: 1, orgSlug: 'default' })
    vi.mocked(listRolesV2).mockResolvedValue(ROLES)
    // 数字 2（organization-roles-query.ts:22 写法）
    const first = createMocks({
      method: 'GET',
      query: { slug: 'default' },
      headers: { Version: 2 as never },
    })
    await handler(first.req as never, first.res as never, claimsOf('g-1'))
    expect(first.res._getStatusCode()).toBe(200)
    expect(first.res._getJSONData()).toEqual(ROLES)
    // 字符串 '2'（assign-mutation.ts:30 写法）
    const second = createMocks({
      method: 'GET',
      query: { slug: 'default' },
      headers: { Version: '2' },
    })
    await handler(second.req as never, second.res as never, claimsOf('g-1'))
    expect(second.res._getStatusCode()).toBe(200)
    // 无 header 也一样（本路由只有 V2 语义，header 不分支）
    const third = createMocks({ method: 'GET', query: { slug: 'default' } })
    await handler(third.req as never, third.res as never, claimsOf('g-1'))
    expect(third.res._getStatusCode()).toBe(200)
    expect(listRolesV2).toHaveBeenCalledWith(1)
  })

  it('short-circuits on guard deny — no data access', async () => {
    vi.mocked(guardOrgRoute).mockImplementation(async (res) => {
      res.status(403).json({ message: 'Forbidden' })
      return null
    })
    const { req, res } = createMocks({ method: 'GET', query: { slug: 'default' } })
    await handler(req as never, res as never, claimsOf('g-0'))
    expect(res._getStatusCode()).toBe(403)
    expect(listRolesV2).not.toHaveBeenCalled()
  })

  it('405 for non-GET; 400 for array slug', async () => {
    const post = createMocks({ method: 'POST', query: { slug: 'default' } })
    await handler(post.req as never, post.res as never, claimsOf('g-1'))
    expect(post.res._getStatusCode()).toBe(405)
    const arr = createMocks({ method: 'GET', query: { slug: ['a', 'b'] } })
    await handler(arr.req as never, arr.res as never, claimsOf('g-1'))
    expect(arr.res._getStatusCode()).toBe(400)
  })
})
