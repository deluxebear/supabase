import { describe, expect, it } from 'vitest'

import { lifecycleParameters, lifecycleValueLabel } from './SelfPlatformLifecyclePanel.utils'

describe('lifecycle panel utilities', () => {
  it.each([
    ['runtime.restart', 'auth', 1, { service: 'auth' }],
    ['runtime.scale', 'storage', 3, { service: 'storage', replicas: 3 }],
    ['postgres.upgrade.execute', '16', 1, { targetVersion: '16' }],
    ['replica.remove', 'replica-a', 1, { replicaName: 'replica-a' }],
    ['branch.create', 'preview-a', 1, { branchName: 'preview-a', sourceBranch: 'main' }],
    [
      'network.bans.update',
      '10.0.0.0/8, 192.0.2.1',
      1,
      { bannedNetworks: ['10.0.0.0/8', '192.0.2.1'] },
    ],
  ] as const)('builds typed parameters for %s', (action, value, replicas, expected) => {
    expect(lifecycleParameters(action, value, replicas)).toEqual(expected)
  })
  it('does not request parameters for a read-only network plan', () => {
    expect(lifecycleParameters('network.bans.read', 'ignored', 1)).toEqual({})
    expect(lifecycleValueLabel('network.bans.read')).toBeNull()
  })
})
