import { ReportFilterItem } from '@/components/interfaces/Reports/Reports.types'
import { USE_LOGFLARE_PG_SQL } from '@/data/logs/logflare-dialect'

// [self-platform] M6.2: `identifier` is a Supabase-cloud multi-database
// routing column on the BigQuery log tables. Self-hosted Logflare tables
// (the logs.all CTEs) have no such column — filtering on it fails BQ→PG
// translation, 500ing every report chart once the database selector
// hydrates. A non-cloud Studio talks to exactly one database per project,
// so the filter is meaningless there and is skipped.
export function mergeDatabaseIdentifierFilter(
  filters: ReportFilterItem[],
  identifier: string | undefined
): ReportFilterItem[] {
  if (identifier === undefined || USE_LOGFLARE_PG_SQL) return filters
  return [...filters, { key: 'identifier', value: identifier, compare: 'is' } as ReportFilterItem]
}
