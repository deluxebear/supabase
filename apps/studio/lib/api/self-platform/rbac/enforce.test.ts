import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getMemberContext } from '../members'
import { ProjectNotFound, resolveProjectConnection } from '../resolve-connection'
import { checkPermission, checkPermissionWithContext, guardProjectRoute } from './enforce'

vi.mock('../members', () => ({ getMemberContext: vi.fn() }))
vi.mock('../resolve-connection', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveProjectConnection: vi.fn(),
}))

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
      await checkPermission({ sub: 'g-0' }, { action: 'read:Read', resource: 'projects' })
    ).toBe(false)
  })

  it('Owner passes credential checks; Developer does not', async () => {
    vi.mocked(getMemberContext).mockResolvedValue(OWNER)
    expect(
      await checkPermission(
        { sub: 'g-1' },
        { action: 'secrets:Read', resource: 'projects', projectRef: 'default' }
      )
    ).toBe(true)
    vi.mocked(getMemberContext).mockResolvedValue(DEV)
    expect(
      await checkPermission(
        { sub: 'g-3' },
        { action: 'secrets:Read', resource: 'projects', projectRef: 'default' }
      )
    ).toBe(false)
    expect(
      await checkPermission(
        { sub: 'g-3' },
        { action: 'tenant:Sql:Admin:Write', resource: 'tables', projectRef: 'default' }
      )
    ).toBe(true)
  })

  it('checkPermissionWithContext returns the loaded context', async () => {
    vi.mocked(getMemberContext).mockResolvedValue(DEV)
    const { can, ctx } = await checkPermissionWithContext(
      { sub: 'g-3' },
      { action: 'tenant:Sql:Query', resource: 'projects', projectRef: 'default' }
    )
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
      guardProjectRoute(res, { sub: 'g-1' }, { action: 'read:Read', projectRef: 'ghost' })
    ).rejects.toBeInstanceOf(ProjectNotFound)
    expect(vi.mocked(getMemberContext)).not.toHaveBeenCalled()
  })

  it('sends 403 {message: Forbidden} and returns false when denied', async () => {
    vi.mocked(resolveProjectConnection).mockResolvedValue({} as never)
    vi.mocked(getMemberContext).mockResolvedValue(ZERO)
    const { res } = createMocks()
    expect(
      await guardProjectRoute(res, { sub: 'g-0' }, { action: 'read:Read', projectRef: 'default' })
    ).toBe(false)
    expect(res._getStatusCode()).toBe(403)
    expect(res._getJSONData()).toEqual({ message: 'Forbidden' })
  })

  it('returns true and sends nothing when allowed', async () => {
    vi.mocked(resolveProjectConnection).mockResolvedValue({} as never)
    vi.mocked(getMemberContext).mockResolvedValue(OWNER)
    const { res } = createMocks()
    expect(
      await guardProjectRoute(res, { sub: 'g-1' }, { action: 'read:Read', projectRef: 'default' })
    ).toBe(true)
    expect(res._isEndCalled()).toBe(false)
  })
})
