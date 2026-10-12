import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { requireProjectCapability } from './attachment'
import { createLifecycleImpactPlan } from './lifecycle'
import { requestManagementDomain, syncProjectManagementBinding } from './management-trust'

vi.mock('./attachment', () => ({ requireProjectCapability: vi.fn() }))
vi.mock('./db', () => ({ executePlatformQuery: vi.fn() }))
vi.mock('./desired-state', () => ({ commitDesiredConfiguration: vi.fn() }))
vi.mock('./ownership-policy', () => ({ listProjectOwnershipPolicies: vi.fn() }))
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
