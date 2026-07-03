// [self-platform] M3.1 Task 10: RBAC guard coverage for the M3.0 final-review
// I2 batch — v1 functions (artifact store) + types/typescript. Guard fully
// mocked (decision logic covered by enforce.test.ts); pins (a) action +
// projectRef declaration, (b) deny short-circuits before data access,
// (c) allow reaches it.
import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'

const claimsOf = (sub: string) => ({ sub }) as JwtPayload

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
})
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardProjectRoute: vi.fn() }))

const { getFunctions, getFunctionBySlug, getFileEntriesBySlug } = vi.hoisted(() => ({
  getFunctions: vi.fn(),
  getFunctionBySlug: vi.fn(),
  getFileEntriesBySlug: vi.fn(),
}))
vi.mock('@/lib/api/self-hosted/functions', () => ({
  getFunctionsArtifactStore: () => ({ getFunctions, getFunctionBySlug, getFileEntriesBySlug }),
}))

const { generateTypescriptTypes } = vi.hoisted(() => ({ generateTypescriptTypes: vi.fn() }))
vi.mock('@/lib/api/self-hosted/generate-types', () => ({ generateTypescriptTypes }))

// never-param 函数类型：任何具体 handler 都可赋值（strictFunctionTypes 下
// unknown-param 形态反而不行）
type Handler = (req: never, res: never, claims?: JwtPayload) => unknown

type Route = [
  label: string,
  importer: () => Promise<{ handler: Handler }>,
  action: string,
  query: Record<string, string>,
  dataAccess: () => ReturnType<typeof vi.fn>,
]

const ROUTES: Route[] = [
  [
    'functions/index',
    () => import('./index'),
    PermissionAction.FUNCTIONS_READ,
    { ref: 'proj-b' },
    () => getFunctions,
  ],
  [
    'functions/[slug]/index',
    () => import('./[slug]/index'),
    PermissionAction.FUNCTIONS_READ,
    { ref: 'proj-b', slug: 'fn-a' },
    () => getFunctionBySlug,
  ],
  [
    'functions/[slug]/body',
    () => import('./[slug]/body'),
    PermissionAction.FUNCTIONS_READ,
    { ref: 'proj-b', slug: 'fn-a' },
    () => getFileEntriesBySlug,
  ],
  [
    'types/typescript',
    () => import('../types/typescript'),
    PermissionAction.TENANT_SQL_ADMIN_READ,
    { ref: 'proj-b' },
    () => generateTypescriptTypes,
  ],
]

beforeEach(() => {
  vi.mocked(guardProjectRoute).mockReset()
  getFunctions.mockReset().mockResolvedValue([])
  getFunctionBySlug.mockReset().mockResolvedValue(null)
  getFileEntriesBySlug.mockReset().mockResolvedValue([])
  generateTypescriptTypes.mockReset().mockResolvedValue('export type X = 1')
})

describe.each(ROUTES)('%s GET guard', (_label, importer, action, query, dataAccess) => {
  it(`declares ${action} and stops on deny before data access`, async () => {
    const { handler } = await importer()
    vi.mocked(guardProjectRoute).mockImplementation(async (res) => {
      res.status(403).json({ message: 'Forbidden' })
      return false
    })
    const { req, res } = createMocks({ method: 'GET', query })
    await handler(req as never, res as never, claimsOf('g-0'))
    expect(vi.mocked(guardProjectRoute).mock.calls[0][2]).toMatchObject({
      action,
      projectRef: 'proj-b',
    })
    expect(res._getStatusCode()).toBe(403)
    expect(dataAccess()).not.toHaveBeenCalled()
  })

  it('allows through to data access when the guard permits', async () => {
    const { handler } = await importer()
    vi.mocked(guardProjectRoute).mockResolvedValue(true)
    const { req, res } = createMocks({ method: 'GET', query })
    await handler(req as never, res as never, claimsOf('g-1'))
    expect(dataAccess()).toHaveBeenCalled()
    expect(res._getStatusCode()).not.toBe(403)
  })
})
