// [self-platform] Task 12: readOnly-DSN threading (spec §7.4) — a member's
// effective base role on the requested ref decides whether executeQuery
// hits the read-only DSN. Ghost/404-before-403 and the plain (self-platform
// off) path are covered by index.test.ts / index.self-hosted.test.ts; this
// file owns the readOnly matrix.
import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './index'
import { executeQuery } from '@/lib/api/self-hosted/query'
import { checkPermissionWithContext } from '@/lib/api/self-platform/rbac/enforce'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
})

const { resolveProjectConnection } = vi.hoisted(() => ({ resolveProjectConnection: vi.fn() }))
// [self-platform] importOriginal spread: ProjectNotFound is a real class
// used elsewhere (instanceof checks); only resolveProjectConnection itself
// is a mock here.
vi.mock('@/lib/api/self-platform/resolve-connection', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveProjectConnection,
}))
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ checkPermissionWithContext: vi.fn() }))
vi.mock('@/lib/api/self-hosted/query', () => ({ executeQuery: vi.fn() }))

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
const OWNER_CTX = { gotrueId: 'g-1', roles: [roleOf({})] }
const READONLY_CTX = {
  gotrueId: 'g-4',
  roles: [roleOf({ id: 4, baseRoleId: 4, baseRoleName: 'Read-only', name: 'Read-only' })],
}
// Derived Developer role scoped to proj-b only (spec: derived roles carry
// their role_projects scope; effectiveBaseRoleName must not leak Read-only
// defaults onto a ref the role explicitly covers as Developer).
const DERIVED_DEV_CTX = {
  gotrueId: 'g-5',
  roles: [
    roleOf({
      id: 5,
      baseRoleId: 3,
      baseRoleName: 'Developer',
      name: 'Developer_scoped',
      projectRefs: ['proj-b'],
      projectIds: [10],
    }),
  ],
}
const ZERO_CTX = { gotrueId: 'g-0', roles: [] }

beforeEach(() => {
  resolveProjectConnection.mockReset().mockResolvedValue({
    pgConnEncrypted: 'ENC',
    pgConnReadOnlyEncrypted: 'ENC-RO',
  })
  vi.mocked(checkPermissionWithContext).mockReset()
  vi.mocked(executeQuery)
    .mockReset()
    .mockResolvedValue({ data: [{ ok: true }], error: undefined })
})

const postQuery = (ref: string) =>
  createMocks({ method: 'POST', query: { ref }, body: { query: 'select 1' } })

describe('POST /platform/pg-meta/[ref]/query readOnly threading (self-platform)', () => {
  it('Owner ctx -> executeQuery called with readOnly: false', async () => {
    vi.mocked(checkPermissionWithContext).mockResolvedValue({ can: true, ctx: OWNER_CTX })
    const { req, res } = postQuery('default')
    await handler(req as any, res as any, claimsOf('g-1'))

    expect(res._getStatusCode()).toBe(200)
    expect(executeQuery).toHaveBeenCalledWith(
      expect.objectContaining({ projectRef: 'default', readOnly: false })
    )
  })

  it('Read-only ctx -> executeQuery called with readOnly: true (spec §7.4)', async () => {
    vi.mocked(checkPermissionWithContext).mockResolvedValue({ can: true, ctx: READONLY_CTX })
    const { req, res } = postQuery('default')
    await handler(req as any, res as any, claimsOf('g-4'))

    expect(res._getStatusCode()).toBe(200)
    expect(executeQuery).toHaveBeenCalledWith(
      expect.objectContaining({ projectRef: 'default', readOnly: true })
    )
  })

  it('derived Developer ctx on proj-b, request ref proj-b -> readOnly: false', async () => {
    vi.mocked(checkPermissionWithContext).mockResolvedValue({ can: true, ctx: DERIVED_DEV_CTX })
    const { req, res } = postQuery('proj-b')
    await handler(req as any, res as any, claimsOf('g-5'))

    expect(res._getStatusCode()).toBe(200)
    expect(executeQuery).toHaveBeenCalledWith(
      expect.objectContaining({ projectRef: 'proj-b', readOnly: false })
    )
  })

  it('denied -> 403 {message: Forbidden}, executeQuery NOT called', async () => {
    vi.mocked(checkPermissionWithContext).mockResolvedValue({ can: false, ctx: ZERO_CTX })
    const { req, res } = postQuery('default')
    await handler(req as any, res as any, claimsOf('g-0'))

    expect(res._getStatusCode()).toBe(403)
    expect(res._getJSONData()).toEqual({ message: 'Forbidden' })
    expect(executeQuery).not.toHaveBeenCalled()
  })
})
