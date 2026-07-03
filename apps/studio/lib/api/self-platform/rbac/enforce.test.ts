import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getMemberContext } from '../members'
import { listOrganizationsForProfile } from '../organizations'
import { ProjectNotFound, resolveProjectConnection } from '../resolve-connection'
import {
  checkPermission,
  checkPermissionWithContext,
  guardOrgRoute,
  guardProjectRoute,
} from './enforce'

vi.mock('../members', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getMemberContext: vi.fn(),
}))
vi.mock('../organizations', () => ({ listOrganizationsForProfile: vi.fn() }))
vi.mock('../resolve-connection', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveProjectConnection: vi.fn(),
}))

const claimsOf = (sub: string) => ({ sub }) as JwtPayload

const roleOf = (over: object) => ({
  id: 1,
  baseRoleId: 1,
  baseRoleName: 'Owner',
  name: 'Owner',
  orgId: 1,
  orgSlug: 'default',
  projectRefs: [],
  projectIds: [],
  ...over,
})
const OWNER = { gotrueId: 'g-1', roles: [roleOf({})] }
const DEV = {
  gotrueId: 'g-3',
  roles: [roleOf({ id: 3, baseRoleId: 3, baseRoleName: 'Developer', name: 'Developer' })],
}
const ZERO = { gotrueId: 'g-0', roles: [] }

describe('checkPermission', () => {
  beforeEach(() => {
    vi.mocked(getMemberContext).mockReset()
    vi.mocked(resolveProjectConnection).mockReset()
  })

  it('fails closed without claims — no context fetch', async () => {
    expect(await checkPermission(undefined, { action: 'read:Read', resource: 'projects' })).toBe(
      false
    )
    expect(vi.mocked(getMemberContext)).not.toHaveBeenCalled()
  })

  it('fails closed with zero roles', async () => {
    vi.mocked(getMemberContext).mockResolvedValue(ZERO)
    expect(
      await checkPermission(claimsOf('g-0'), { action: 'read:Read', resource: 'projects' })
    ).toBe(false)
  })

  it('Owner passes credential checks; Developer does not', async () => {
    vi.mocked(getMemberContext).mockResolvedValue(OWNER)
    expect(
      await checkPermission(claimsOf('g-1'), {
        action: 'secrets:Read',
        resource: 'projects',
        projectRef: 'default',
      })
    ).toBe(true)
    vi.mocked(getMemberContext).mockResolvedValue(DEV)
    expect(
      await checkPermission(claimsOf('g-3'), {
        action: 'secrets:Read',
        resource: 'projects',
        projectRef: 'default',
      })
    ).toBe(false)
    expect(
      await checkPermission(claimsOf('g-3'), {
        action: 'tenant:Sql:Admin:Write',
        resource: 'tables',
        projectRef: 'default',
      })
    ).toBe(true)
  })

  it('checkPermissionWithContext returns the loaded context', async () => {
    vi.mocked(getMemberContext).mockResolvedValue(DEV)
    const { can, ctx } = await checkPermissionWithContext(claimsOf('g-3'), {
      action: 'tenant:Sql:Query',
      resource: 'projects',
      projectRef: 'default',
    })
    expect(can).toBe(true)
    expect(ctx).toBe(DEV)
  })
})

describe('guardProjectRoute (404 before 403)', () => {
  beforeEach(() => {
    vi.mocked(getMemberContext).mockReset()
    vi.mocked(resolveProjectConnection).mockReset()
  })

  it('propagates ProjectNotFound before any permission work', async () => {
    vi.mocked(resolveProjectConnection).mockRejectedValue(new ProjectNotFound('ghost'))
    const { res } = createMocks()
    await expect(
      guardProjectRoute(res, claimsOf('g-1'), { action: 'read:Read', projectRef: 'ghost' })
    ).rejects.toBeInstanceOf(ProjectNotFound)
    expect(vi.mocked(getMemberContext)).not.toHaveBeenCalled()
  })

  it('sends 403 {message: Forbidden} and returns false when denied', async () => {
    vi.mocked(resolveProjectConnection).mockResolvedValue({} as never)
    vi.mocked(getMemberContext).mockResolvedValue(ZERO)
    const { res } = createMocks()
    expect(
      await guardProjectRoute(res, claimsOf('g-0'), { action: 'read:Read', projectRef: 'default' })
    ).toBe(false)
    expect(res._getStatusCode()).toBe(403)
    expect(res._getJSONData()).toEqual({ message: 'Forbidden' })
  })

  it('returns true and sends nothing when allowed', async () => {
    vi.mocked(resolveProjectConnection).mockResolvedValue({} as never)
    vi.mocked(getMemberContext).mockResolvedValue(OWNER)
    const { res } = createMocks()
    expect(
      await guardProjectRoute(res, claimsOf('g-1'), { action: 'read:Read', projectRef: 'default' })
    ).toBe(true)
    expect(res._isEndCalled()).toBe(false)
  })
})

describe('checkPermission orgSlug override (M3.1)', () => {
  beforeEach(() => {
    vi.mocked(getMemberContext).mockReset()
  })

  it('evaluates against the supplied orgSlug instead of the member ctx slug', async () => {
    // 成员角色挂在 default org；对 other-org 评估必须拒绝
    vi.mocked(getMemberContext).mockResolvedValue(OWNER)
    expect(
      await checkPermission(claimsOf('g-1'), {
        action: 'read:Read',
        resource: 'organizations',
        orgSlug: 'other-org',
      })
    ).toBe(false)
    expect(
      await checkPermission(claimsOf('g-1'), {
        action: 'read:Read',
        resource: 'organizations',
        orgSlug: 'default',
      })
    ).toBe(true)
  })

  it('Admin owner-protection fires ONLY when condition data is supplied (load-bearing)', async () => {
    const ADMIN = {
      gotrueId: 'g-2',
      roles: [
        roleOf({ id: 2, baseRoleId: 2, baseRoleName: 'Administrator', name: 'Administrator' }),
      ],
    }
    vi.mocked(getMemberContext).mockResolvedValue(ADMIN)
    // 带 data：授 Owner(role_id=1) 被 restrictive deny 拒
    expect(
      await checkPermission(claimsOf('g-2'), {
        action: 'write:Create',
        resource: 'auth.subject_roles',
        orgSlug: 'default',
        data: { resource: { role_id: 1 } },
      })
    ).toBe(false)
    // 带 data：授 Developer(role_id=3) 放行
    expect(
      await checkPermission(claimsOf('g-2'), {
        action: 'write:Create',
        resource: 'auth.subject_roles',
        orgSlug: 'default',
        data: { resource: { role_id: 3 } },
      })
    ).toBe(true)
    // 不带 data：deny condition 摸不到 role_id → 不触发 → 放行。
    // 这条测试文档化了"路由必须传 data"这一约束的原因。
    expect(
      await checkPermission(claimsOf('g-2'), {
        action: 'write:Create',
        resource: 'auth.subject_roles',
        orgSlug: 'default',
      })
    ).toBe(true)
  })
})

describe('guardOrgRoute', () => {
  beforeEach(() => {
    vi.mocked(getMemberContext).mockReset()
    vi.mocked(listOrganizationsForProfile).mockReset()
  })

  const mockRes = () => createMocks({ method: 'GET' }).res

  it('401 without claims, no queries fired', async () => {
    const res = mockRes()
    const out = await guardOrgRoute(res as never, undefined, {
      slug: 'default',
      action: 'read:Read',
    })
    expect(out).toBeNull()
    expect(res._getStatusCode()).toBe(401)
    expect(res._getJSONData()).toEqual({ message: 'Unauthorized: missing token claims' })
    expect(vi.mocked(listOrganizationsForProfile)).not.toHaveBeenCalled()
  })

  it('404 when caller is not a member of the slug org (info hiding), before permission check', async () => {
    vi.mocked(listOrganizationsForProfile).mockResolvedValue([
      { id: 1, slug: 'default', name: 'Default Organization' },
    ])
    const res = mockRes()
    const out = await guardOrgRoute(res as never, claimsOf('g-1'), {
      slug: 'ghost-org',
      action: 'read:Read',
    })
    expect(out).toBeNull()
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ message: 'Organization not found' })
    expect(vi.mocked(getMemberContext)).not.toHaveBeenCalled()
  })

  it('403 for a member without the permission (zero-role fail-closed)', async () => {
    vi.mocked(listOrganizationsForProfile).mockResolvedValue([
      { id: 1, slug: 'default', name: 'Default Organization' },
    ])
    vi.mocked(getMemberContext).mockResolvedValue(ZERO)
    const res = mockRes()
    const out = await guardOrgRoute(res as never, claimsOf('g-0'), {
      slug: 'default',
      action: 'read:Read',
    })
    expect(out).toBeNull()
    expect(res._getStatusCode()).toBe(403)
    expect(res._getJSONData()).toEqual({ message: 'Forbidden' })
  })

  it('returns org context on success and defaults resource to organizations', async () => {
    vi.mocked(listOrganizationsForProfile).mockResolvedValue([
      { id: 1, slug: 'default', name: 'Default Organization' },
    ])
    vi.mocked(getMemberContext).mockResolvedValue(OWNER)
    const res = mockRes()
    const out = await guardOrgRoute(res as never, claimsOf('g-1'), {
      slug: 'default',
      action: 'read:Read',
    })
    expect(out).toEqual({ orgId: 1, orgSlug: 'default' })
    expect(res._getStatusCode()).not.toBe(403)
  })
})
