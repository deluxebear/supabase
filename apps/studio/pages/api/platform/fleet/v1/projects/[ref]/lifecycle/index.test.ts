import type { JwtPayload } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './index'

const mocks = vi.hoisted(() => ({
  guard: vi.fn(),
  plan: vi.fn(),
  generation: vi.fn(),
  execute: vi.fn(),
}))
vi.mock('@/lib/constants/deployment-profile', () => ({
  STUDIO_DEPLOYMENT_PROFILE: 'fleet',
  STUDIO_CAPABILITIES: { lifecycleManagement: true },
}))
vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardProjectRoute: mocks.guard }))
vi.mock('@/lib/api/self-platform/lifecycle', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/self-platform/lifecycle')>()
  return {
    ...actual,
    createLifecycleImpactPlan: mocks.plan,
    getLifecycleGeneration: mocks.generation,
    executeLifecyclePlan: mocks.execute,
  }
})

function response() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, unknown>,
    status(code: number) {
      this.statusCode = code
      return this
    },
    json(body: unknown) {
      this.body = body
      return this
    },
    setHeader(name: string, value: unknown) {
      this.headers[name] = value
    },
  }
  return res
}
function request(body: unknown, headers: Record<string, string> = {}) {
  return { method: 'POST', query: { ref: 'project-a' }, body, headers } as never
}

const plan = {
  schema: 'supabase.fleet.lifecycle.impact-plan.v1',
  id: 'plan-a',
  projectRef: 'project-a',
  action: 'runtime.restart',
  adapter: 'compose',
  parameters: { service: 'auth' },
  componentVersions: {
    postgres: '15',
    gotrue: '2',
    postgrest: '12',
    storage: '1',
    realtime: '2',
    edgeRuntime: '1',
    gateway: '3',
    adapter: '1',
    fleetControl: '1',
    backupOperator: '1',
    agent: '1',
  },
  impact: {
    serviceInterruption: true,
    writeUnavailability: false,
    dataLossRisk: 'none',
    affectedServices: ['auth'],
    estimatedSeconds: 120,
  },
  verification: [],
  rollback: [],
  manualIntervention: [],
  requiresRecentAal2: false,
  requiresExplicitConfirmation: true,
  createdAt: '2026-07-15T00:00:00Z',
  expiresAt: '2026-07-15T00:10:00Z',
  hash: 'a'.repeat(64),
} as const

describe('Fleet lifecycle API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.guard.mockResolvedValue(true)
    mocks.plan.mockResolvedValue(plan)
    mocks.generation.mockResolvedValue(2)
    mocks.execute.mockResolvedValue({ operationId: 'op-a' })
  })
  it('checks project RBAC before creating a project-scoped plan', async () => {
    const res = response()
    await handler(
      request({
        phase: 'plan',
        input: { action: 'runtime.restart', parameters: { service: 'auth' } },
      }),
      res as never,
      { sub: 'user-a' } as JwtPayload
    )
    expect(mocks.guard).toHaveBeenCalledWith(
      res,
      expect.anything(),
      expect.objectContaining({ projectRef: 'project-a' })
    )
    expect(mocks.plan).toHaveBeenCalledWith(
      expect.objectContaining({ projectRef: 'project-a', actor: 'user-a' })
    )
    expect(res.statusCode).toBe(201)
    expect(res.body).toEqual({ plan, expectedGeneration: 2 })
  })
  it('stops before lifecycle access when RBAC denies', async () => {
    mocks.guard.mockResolvedValue(false)
    const res = response()
    await handler(
      request({
        phase: 'plan',
        input: { action: 'runtime.restart', parameters: { service: 'auth' } },
      }),
      res as never,
      { sub: 'user-b' } as JwtPayload
    )
    expect(mocks.plan).not.toHaveBeenCalled()
  })
  it('requires a recent AAL2 session for destructive execution', async () => {
    const res = response()
    await handler(
      request(
        {
          phase: 'execute',
          input: { plan: { ...plan, requiresRecentAal2: true }, expectedGeneration: 2 },
        },
        { 'idempotency-key': 'key-a' }
      ),
      res as never,
      { sub: 'user-a', aal: 'aal1' } as JwtPayload
    )
    expect(res.statusCode).toBe(403)
    expect(mocks.execute).not.toHaveBeenCalled()
  })
  it('forwards the verified AAL2 context into immutable execution preconditions', async () => {
    const authenticatedAt = Math.floor(Date.now() / 1000) - 60
    const res = response()
    await handler(
      request(
        {
          phase: 'execute',
          input: { plan: { ...plan, requiresRecentAal2: true }, expectedGeneration: 2 },
        },
        { 'idempotency-key': 'key-a' }
      ),
      res as never,
      { sub: 'user-a', aal: 'aal2', iat: authenticatedAt } as JwtPayload
    )
    expect(res.statusCode).toBe(202)
    expect(mocks.execute).toHaveBeenCalledWith(
      expect.objectContaining({ aal: 'aal2', aalAuthenticatedAt: authenticatedAt })
    )
  })
})
