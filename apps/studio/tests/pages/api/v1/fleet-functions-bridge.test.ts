import type { JwtPayload } from '@supabase/supabase-js'
import type { NextApiRequest, NextApiResponse } from 'next'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  guardProjectRoute: vi.fn(),
  requireProjectCapability: vi.fn(),
  listFunctionDeployments: vi.fn(),
  getFunctionDeployment: vi.fn(),
  downloadFunctionArtifact: vi.fn(),
}))

vi.mock('@/lib/constants/deployment-profile', () => ({ STUDIO_DEPLOYMENT_PROFILE: 'fleet' }))
vi.mock('@/lib/constants/self-platform', () => ({ IS_SELF_PLATFORM: true }))
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({
  guardProjectRoute: mocks.guardProjectRoute,
}))
vi.mock('@/lib/api/self-platform/attachment', () => ({
  requireProjectCapability: mocks.requireProjectCapability,
}))
vi.mock('@/lib/api/self-platform/function-deployments', () => ({
  listFunctionDeployments: mocks.listFunctionDeployments,
  getFunctionDeployment: mocks.getFunctionDeployment,
  downloadFunctionArtifact: mocks.downloadFunctionArtifact,
}))
vi.mock('@/lib/api/self-hosted/functions', () => ({
  getFunctionsArtifactStore: vi.fn(() => {
    throw new Error('Fleet must not use the Embedded function artifact store')
  }),
}))

type FleetReadHandler = (req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) => unknown

type FleetReadRoute = {
  name: string
  importer: () => Promise<{ handler: FleetReadHandler }>
  query: Record<string, string>
  downstream: ReturnType<typeof vi.fn>
}

const routes: FleetReadRoute[] = [
  {
    name: 'list',
    importer: () => import('@/pages/api/v1/projects/[ref]/functions'),
    query: { ref: 'project-a' },
    downstream: mocks.listFunctionDeployments,
  },
  {
    name: 'detail',
    importer: () => import('@/pages/api/v1/projects/[ref]/functions/[slug]'),
    query: { ref: 'project-a', slug: 'hello' },
    downstream: mocks.getFunctionDeployment,
  },
  {
    name: 'body',
    importer: () => import('@/pages/api/v1/projects/[ref]/functions/[slug]/body'),
    query: { ref: 'project-a', slug: 'hello' },
    downstream: mocks.getFunctionDeployment,
  },
]

beforeEach(() => {
  vi.clearAllMocks()
  mocks.guardProjectRoute.mockResolvedValue(true)
  mocks.requireProjectCapability.mockResolvedValue(undefined)
  mocks.listFunctionDeployments.mockResolvedValue([])
})

describe.each(routes)('Fleet functions $name bridge', ({ importer, query, downstream }) => {
  it('checks the exact project functions.read capability before data access', async () => {
    const unavailable = new Error('capability unavailable')
    mocks.requireProjectCapability.mockRejectedValue(unavailable)
    const { handler } = await importer()
    const { req, res } = createMocks({ method: 'GET', query })

    await expect(handler(req, res, { sub: 'actor-a' } as JwtPayload)).rejects.toBe(unavailable)

    expect(mocks.guardProjectRoute).toHaveBeenCalledWith(
      res,
      expect.objectContaining({ sub: 'actor-a' }),
      expect.objectContaining({ projectRef: 'project-a' })
    )
    expect(mocks.requireProjectCapability).toHaveBeenCalledWith('project-a', 'functions.read')
    expect(downstream).not.toHaveBeenCalled()
  })
})

it('keeps Fleet function listing scoped to the requested project', async () => {
  const { handler } = await import('@/pages/api/v1/projects/[ref]/functions')
  const { req, res } = createMocks({ method: 'GET', query: { ref: 'project-b' } })

  await handler(req, res, { sub: 'actor-b' } as JwtPayload)

  expect(mocks.listFunctionDeployments).toHaveBeenCalledWith('project-b')
  expect(res._getStatusCode()).toBe(200)
})
