import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ReportFilterItem } from '@/components/interfaces/Reports/Reports.types'

async function loadReportFilters(platform: string, selfPlatform: string) {
  // [self-platform] see data/logs/logflare-dialect.test.ts for why
  // `vi.doUnmock('common')` is required before re-stubbing NEXT_PUBLIC_IS_PLATFORM
  // to a different value within the same test file.
  vi.doUnmock('common')
  vi.resetModules()
  vi.stubEnv('NEXT_PUBLIC_IS_PLATFORM', platform)
  vi.stubEnv('NEXT_PUBLIC_SELF_PLATFORM', selfPlatform)
  return await import('./report-filters')
}

afterEach(() => {
  vi.unstubAllEnvs()
})

const existingFilters: ReportFilterItem[] = [{ key: 'method', value: 'GET', compare: 'is' }]

describe('mergeDatabaseIdentifierFilter', () => {
  it('appends the identifier filter for cloud (IS_PLATFORM=true, SELF_PLATFORM unset)', async () => {
    const mod = await loadReportFilters('true', '')
    const result = mod.mergeDatabaseIdentifierFilter(existingFilters, 'db-1')
    expect(result).toEqual([
      { key: 'method', value: 'GET', compare: 'is' },
      { key: 'identifier', value: 'db-1', compare: 'is' },
    ])
    // preserves existing filters order
    expect(result[0]).toBe(existingFilters[0])
  })

  it('leaves filters unchanged for a self-platform build (IS_PLATFORM=true AND SELF_PLATFORM=true)', async () => {
    const mod = await loadReportFilters('true', 'true')
    const result = mod.mergeDatabaseIdentifierFilter(existingFilters, 'db-1')
    expect(result).toEqual(existingFilters)
    expect(result.some((f) => f.key === 'identifier')).toBe(false)
  })

  it('leaves filters unchanged for plain self-hosted (IS_PLATFORM=false, SELF_PLATFORM=false)', async () => {
    const mod = await loadReportFilters('', '')
    const result = mod.mergeDatabaseIdentifierFilter(existingFilters, 'db-1')
    expect(result).toEqual(existingFilters)
    expect(result.some((f) => f.key === 'identifier')).toBe(false)
  })

  it('leaves filters unchanged when identifier is undefined (cloud)', async () => {
    const mod = await loadReportFilters('true', '')
    const result = mod.mergeDatabaseIdentifierFilter(existingFilters, undefined)
    expect(result).toEqual(existingFilters)
  })

  it('leaves filters unchanged when identifier is undefined (self-platform)', async () => {
    const mod = await loadReportFilters('true', 'true')
    const result = mod.mergeDatabaseIdentifierFilter(existingFilters, undefined)
    expect(result).toEqual(existingFilters)
  })

  it('leaves filters unchanged when identifier is undefined (plain self-hosted)', async () => {
    const mod = await loadReportFilters('', '')
    const result = mod.mergeDatabaseIdentifierFilter(existingFilters, undefined)
    expect(result).toEqual(existingFilters)
  })
})
