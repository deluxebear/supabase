// [self-platform] M3.1 Task 10 review fix: zero-break coverage for all four
// v1 functions/typegen routes with a genuinely pinned guard mock. Previously
// this file imported `guardProjectRoute` at top-of-file while each test did
// `vi.resetModules()` + dynamic `import('./index')` — the re-import re-runs
// the `vi.mock` factory and wires a NEW vi.fn into the route, while the
// top-level binding kept pointing at the original instance, so
// `expect(guardProjectRoute).not.toHaveBeenCalled()` passed vacuously. Fix:
// create the fn via `vi.hoisted` and have the factory return that same
// instance — `vi.resetModules()` re-runs the factory, but it keeps
// returning the pinned instance, so assertions against it are load-bearing.
import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { guardProjectRoute } = vi.hoisted(() => ({ guardProjectRoute: vi.fn() }))
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardProjectRoute }))

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

// never-param handler type: any concrete handler is assignable (with
// strictFunctionTypes, an unknown-param shape is not) — see sibling
// functions-rbac.test.ts for the same trick.
type Handler = (req: never, res: never, claims?: JwtPayload) => unknown

type MockRes = ReturnType<typeof createMocks>['res']

type Route = [
  label: string,
  importer: () => Promise<{ handler: Handler }>,
  query: Record<string, string>,
  dataAccess: () => ReturnType<typeof vi.fn>,
  setup: () => void,
  assert: (res: MockRes) => void,
]

const ROUTES: Route[] = [
  [
    'functions/index',
    () => import('./index'),
    { ref: 'default' },
    () => getFunctions,
    () => getFunctions.mockResolvedValue([]),
    (res) => {
      expect(res._getStatusCode()).toBe(200)
      expect(res._getJSONData()).toEqual([])
    },
  ],
  [
    'functions/[slug]/index',
    () => import('./[slug]/index'),
    { ref: 'default', slug: 'fn-a' },
    () => getFunctionBySlug,
    () =>
      getFunctionBySlug.mockResolvedValue({
        slug: 'fn-a',
        entrypoint_path: 'index.ts',
        created_at: 1,
        updated_at: 1,
      }),
    (res) => {
      expect(res._getStatusCode()).toBe(200)
    },
  ],
  [
    'functions/[slug]/body',
    () => import('./[slug]/body'),
    { ref: 'default', slug: 'fn-a' },
    () => getFileEntriesBySlug,
    () => getFileEntriesBySlug.mockResolvedValue([]),
    (res) => {
      // handleGet pipes a real stream into the response, which node-mocks-http
      // doesn't model deterministically — skip asserting the body/exact
      // status here; the guard-not-called + data-access-called pair below is
      // the zero-break signal for this route.
      expect(res._getStatusCode()).not.toBe(403)
    },
  ],
  [
    '../types/typescript',
    () => import('../types/typescript'),
    { ref: 'default' },
    () => generateTypescriptTypes,
    () => generateTypescriptTypes.mockResolvedValue('export type X = 1'),
    (res) => {
      expect(res._getStatusCode()).toBe(200)
      expect(res._getJSONData()).toEqual({ types: 'export type X = 1' })
    },
  ],
]

beforeEach(() => {
  guardProjectRoute.mockReset()
  getFunctions.mockReset()
  getFunctionBySlug.mockReset()
  getFileEntriesBySlug.mockReset()
  generateTypescriptTypes.mockReset()
})

afterEach(() => vi.unstubAllEnvs())

describe.each(ROUTES)(
  'v1 %s — plain self-hosted (zero-break)',
  (_label, importer, query, dataAccess, setup, assert) => {
    it('GET works without any guard call and reaches the data-access layer', async () => {
      setup()
      vi.resetModules()
      vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', '')
      const { handler } = await importer()
      const { req, res } = createMocks({ method: 'GET', query })
      await handler(req as never, res as never, undefined)
      expect(guardProjectRoute).not.toHaveBeenCalled()
      expect(dataAccess()).toHaveBeenCalled()
      assert(res)
    })
  }
)
