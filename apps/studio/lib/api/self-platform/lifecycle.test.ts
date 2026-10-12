import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { requireProjectCapability } from './attachment'
import { commitDesiredConfiguration } from './desired-state'
import { createLifecycleImpactPlan, executeLifecyclePlan } from './lifecycle'
import { requestManagementDomain, syncProjectManagementBinding } from './management-trust'
import { listProjectOwnershipPolicies, setProjectOwnershipPolicy } from './ownership-policy'

vi.mock('./attachment', () => ({ requireProjectCapability: vi.fn() }))
vi.mock('./db', () => ({ executePlatformQuery: vi.fn() }))
vi.mock('./desired-state', () => ({ commitDesiredConfiguration: vi.fn() }))
vi.mock('./ownership-policy', () => ({
  listProjectOwnershipPolicies: vi.fn(),
  setProjectOwnershipPolicy: vi.fn(),
}))
vi.mock('./management-trust', () => ({
  syncProjectManagementBinding: vi.fn(),
  requestManagementDomain: vi.fn(),
}))

const componentVersions = {
  postgres: '17',
  gotrue: '2.196.0',
  postgrest: '14.17',
  storage: '1.74.0',
  realtime: '2.134.10',
  edgeRuntime: '1.76.2',
  gateway: '1.39.1',
  adapter: '1.0.0',
  fleetControl: '1.0.0',
  backupOperator: '1.0.0',
  agent: '1.0.0',
}

describe('createLifecycleImpactPlan', () => {
  beforeEach(() => {
    vi.stubEnv('FLEET_LIFECYCLE_COMPONENT_VERSIONS', JSON.stringify(componentVersions))
    vi.mocked(syncProjectManagementBinding).mockResolvedValue({
      id: 'binding-1',
      state: 'active',
      targetState: 'active',
      deploymentKind: 'compose',
      managementTargetId: 'target-1',
    } as Awaited<ReturnType<typeof syncProjectManagementBinding>>)
    vi.mocked(requestManagementDomain).mockRejectedValue(new Error('stop after binding checks'))
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  it('refreshes Agent capability evidence before checking the lifecycle capability', async () => {
    await expect(
      createLifecycleImpactPlan({
        projectRef: 'project-a',
        value: { action: 'runtime.restart', parameters: { service: 'rest' } },
        actor: 'user-1',
        correlationId: 'correlation-1',
      })
    ).rejects.toThrow('stop after binding checks')

    expect(syncProjectManagementBinding).toHaveBeenCalledWith({
      projectRef: 'project-a',
      actor: 'user-1',
      correlationId: 'correlation-1',
    })
    expect(requireProjectCapability).toHaveBeenCalledWith('project-a', 'runtime.restart')
    expect(vi.mocked(syncProjectManagementBinding).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(requireProjectCapability).mock.invocationCallOrder[0]
    )
  })
})

describe('executeLifecyclePlan', () => {
  const plan = {
    schema: 'supabase.fleet.lifecycle.impact-plan.v1' as const,
    id: 'plan-1',
    projectRef: 'project-a',
    action: 'runtime.restart' as const,
    adapter: 'compose' as const,
    parameters: { service: 'rest' },
    componentVersions,
    impact: {
      serviceInterruption: true,
      writeUnavailability: false,
      dataLossRisk: 'none' as const,
      affectedServices: ['rest'],
      estimatedSeconds: 30,
    },
    verification: [],
    rollback: [],
    manualIntervention: [],
    requiresRecentAal2: true,
    requiresExplicitConfirmation: true,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    hash: 'a'.repeat(64),
  }
  const execute = (confirmOwnership?: boolean) =>
    executeLifecyclePlan({
      projectRef: 'project-a',
      value: { plan, expectedGeneration: 0, idempotencyKey: 'key-1', confirmOwnership },
      actor: 'user-1',
      correlationId: 'correlation-1',
    })

  beforeEach(() => {
    vi.stubEnv('FLEET_LIFECYCLE_COMPONENT_VERSIONS', JSON.stringify(componentVersions))
    vi.mocked(syncProjectManagementBinding).mockResolvedValue({
      id: 'binding-1',
      state: 'active',
      targetState: 'active',
      deploymentKind: 'compose',
      managementTargetId: 'target-1',
    } as Awaited<ReturnType<typeof syncProjectManagementBinding>>)
    vi.mocked(commitDesiredConfiguration).mockResolvedValue({ operationId: 'op-1' } as Awaited<
      ReturnType<typeof commitDesiredConfiguration>
    >)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
  })

  it('requires confirmation before Fleet takes over the runtime domain', async () => {
    vi.mocked(listProjectOwnershipPolicies).mockResolvedValue([])
    await expect(execute()).rejects.toMatchObject({ code: 'ownership_confirmation_required' })
    expect(setProjectOwnershipPolicy).not.toHaveBeenCalled()
    expect(commitDesiredConfiguration).not.toHaveBeenCalled()
  })

  it('hands the runtime domain to Fleet when confirmed, then commits', async () => {
    vi.mocked(listProjectOwnershipPolicies).mockResolvedValue([
      { domain: 'runtime', ownershipMode: 'observe-only', policyRevision: 3, casToken: 'cas-1' },
    ] as Awaited<ReturnType<typeof listProjectOwnershipPolicies>>)
    await execute(true)
    expect(setProjectOwnershipPolicy).toHaveBeenCalledWith({
      projectRef: 'project-a',
      policy: {
        domain: 'runtime',
        ownershipMode: 'direct-managed',
        expectedRevision: 3,
        expectedCasToken: 'cas-1',
      },
      actor: 'user-1',
      correlationId: 'correlation-1',
    })
    expect(vi.mocked(setProjectOwnershipPolicy).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(commitDesiredConfiguration).mock.invocationCallOrder[0]
    )
  })

  it('does not change ownership when a later plan check fails', async () => {
    vi.mocked(listProjectOwnershipPolicies).mockResolvedValue([])
    vi.stubEnv(
      'FLEET_LIFECYCLE_COMPONENT_VERSIONS',
      JSON.stringify({ ...componentVersions, gotrue: '9.9.9' })
    )
    await expect(execute(true)).rejects.toMatchObject({ code: 'plan_confirmation_invalid' })
    expect(setProjectOwnershipPolicy).not.toHaveBeenCalled()
  })

  it('leaves an existing direct-managed policy unchanged', async () => {
    vi.mocked(listProjectOwnershipPolicies).mockResolvedValue([
      { domain: 'runtime', ownershipMode: 'direct-managed', policyRevision: 1, casToken: 'cas' },
    ] as Awaited<ReturnType<typeof listProjectOwnershipPolicies>>)
    await execute()
    expect(setProjectOwnershipPolicy).not.toHaveBeenCalled()
    expect(commitDesiredConfiguration).toHaveBeenCalledOnce()
  })
})
