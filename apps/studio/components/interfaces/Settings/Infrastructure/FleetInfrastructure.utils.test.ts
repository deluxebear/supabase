import { describe, expect, it } from 'vitest'

import {
  formatComputeSource,
  formatVolumeUsage,
  getInventoryCopy,
} from './FleetInfrastructure.utils'

const formatBytes = (value: number) => `${value} B`

describe('FleetInfrastructure utils', () => {
  it('names the inventory source for each adapter', () => {
    expect(getInventoryCopy('compose').workloadsTitle).toBe('Compose containers and volumes')
    expect(getInventoryCopy('kubernetes').workloadsTitle).toBe('Kubernetes pods and volumes')
    expect(getInventoryCopy('kubernetes').description).toContain('Kubernetes namespace')
  })

  it('translates known compute sources and passes unknown ones through', () => {
    expect(formatComputeSource('kubernetes-node-allocatable')).toBe('Database node allocatable')
    expect(formatComputeSource('kubernetes-namespace-quota')).toBe('Namespace resource quota')
    expect(formatComputeSource('compose-host-pool')).toBe('Compose host')
    expect(formatComputeSource('something-else')).toBe('something-else')
  })

  it('never shows 0 B for Kubernetes volumes, whose usage is not reported', () => {
    expect(formatVolumeUsage('compose', { driver: 'local', usedBytes: 42 }, formatBytes)).toBe(
      '42 B'
    )
    expect(
      formatVolumeUsage('kubernetes', { driver: 'local-path', usedBytes: 0 }, formatBytes)
    ).toBe('local-path · usage not reported')
  })
})
