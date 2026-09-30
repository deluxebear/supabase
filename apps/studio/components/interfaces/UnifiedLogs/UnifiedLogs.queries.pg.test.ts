import { describe, expect, it } from 'vitest'

import {
  getFacetCountQuery,
  getLogsChartQuery,
  getUnifiedLogsQuery,
} from './UnifiedLogs.queries.pg'
import type { QuerySearchParamsType } from './UnifiedLogs.types'

const search: Pick<QuerySearchParamsType, 'date' | 'filter'> = {
  date: [new Date('2026-09-30T00:00:00Z'), new Date('2026-09-30T01:00:00Z')],
  filter: null,
}

describe('PG unified logs queries', () => {
  it('uses a native source and explicit UTC time bounds', () => {
    const sql = getUnifiedLogsQuery(search)
    expect(sql).toContain('FROM unified_logs')
    expect(sql).toContain("timestamp >= '2026-09-30T00:00:00.000Z'")
    expect(sql).toContain("timestamp <= '2026-09-30T01:00:00.000Z'")
    expect(sql).not.toMatch(/unnest|log_attributes|WITH /i)
  })
  it('groups included values with OR and excluded values with AND', () => {
    const sql = getUnifiedLogsQuery({
      ...search,
      filter: ['level:eq:error', 'level:eq:warning', 'method:neq:GET', 'method:neq:HEAD'],
    })
    expect(sql).toContain("= 'error' OR")
    expect(sql).toContain("<> 'GET' AND")
  })
  it('quotes values, keeps literal backslashes, and ignores unknown columns', () => {
    const sql = getUnifiedLogsQuery({
      ...search,
      filter: ["event_message:ilike:O'Reilly\\path", 'level OR 1=1:eq:error'],
    })
    expect(sql).toContain("ILIKE '%O''Reilly\\path%'")
    expect(sql).not.toContain('OR 1=1')
  })
  it('counts a facet with all other filters applied', () => {
    const sql = getFacetCountQuery({
      search: { ...search, filter: ['level:eq:error', 'status:eq:500'] },
      facet: 'level',
      facetSearch: 'err',
    })
    expect(sql).not.toContain("= 'error'")
    expect(sql).toContain("= '500'")
    expect(sql).toContain("ILIKE '%err%'")
    expect(sql).toContain('LIMIT 20')
    expect(() => getFacetCountQuery({ search, facet: 'unknown' })).toThrow()
  })
  it('bounds total counts and chooses chart buckets for wider ranges', () => {
    expect(getFacetCountQuery({ search, facet: 'total' })).toContain('LIMIT 1')
    expect(getLogsChartQuery(search)).toContain("date_trunc('minute', timestamp)")
    expect(
      getLogsChartQuery({ ...search, date: [search.date![0], new Date('2026-09-30T13:00:00Z')] })
    ).toContain("date_trunc('hour', timestamp)")
    expect(
      getLogsChartQuery({ ...search, date: [search.date![0], new Date('2026-10-02T00:00:00Z')] })
    ).toContain("date_trunc('day', timestamp)")
  })
})
