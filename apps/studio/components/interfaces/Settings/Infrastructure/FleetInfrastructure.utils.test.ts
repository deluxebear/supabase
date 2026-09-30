import { describe, expect, it } from 'vitest'

import {
  formatComputeSource,
  formatPreflightCheck,
  formatRuntimeStatus,
  formatVolumeUsage,
  getInventoryCopy,
} from './FleetInfrastructure.utils'
import { i18n } from '@/lib/i18n'

const formatBytes = (value: number) => `${value} B`

describe('FleetInfrastructure utils', () => {
  it('localizes runtime states and preflight checks without changing unknown identifiers', async () => {
    const previousLocale = i18n.language
    try {
      await i18n.changeLanguage('zh-CN')
      expect(formatRuntimeStatus('healthy')).toBe('健康')
      expect(formatRuntimeStatus('running')).toBe('正在运行')
      expect(formatRuntimeStatus('not-configured')).toBe('未配置')
      expect(formatRuntimeStatus('idle')).toBe('空闲')
      expect(formatRuntimeStatus('future-state')).toBe('future-state')
      expect(formatPreflightCheck('provider_registration')).toBe('升级执行器注册')
      expect(formatPreflightCheck('future-check')).toBe('future-check')

      await i18n.changeLanguage('en')
      expect(formatRuntimeStatus('healthy')).toBe('Healthy')
      expect(formatPreflightCheck('provider_registration')).toBe('Upgrade provider registration')
    } finally {
      await i18n.changeLanguage(previousLocale)
    }
  })

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
