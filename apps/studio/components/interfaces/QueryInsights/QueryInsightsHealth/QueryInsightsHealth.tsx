import type { QueryPerformanceRow } from '../../QueryPerformance/QueryPerformance.types'
import { useQueryInsightsIssues } from '../hooks/useQueryInsightsIssues'
import { useQueryInsightsMetrics } from '../hooks/useQueryInsightsMetrics'
import { useQueryInsightsScore } from '../hooks/useQueryInsightsScore'
import { HEALTH_COLORS, HEALTH_LEVELS } from './QueryInsightsHealth.constants'
import { QueryInsightsHealthMetric } from './QueryInsightsHealthMetric'
import { QueryInsightsHealthScore } from './QueryInsightsHealthScore'
import { QueryInsightsHealthScoreSkeleton } from './QueryInsightsHealthScoreSkeleton'
import { t as $t } from '@/lib/i18n'

interface QueryInsightsHealthProps {
  data: QueryPerformanceRow[]
  isLoading: boolean
}

export const QueryInsightsHealth = ({ data, isLoading }: QueryInsightsHealthProps) => {
  const { errors, indexIssues, slowQueries } = useQueryInsightsIssues(data)
  const { score, level } = useQueryInsightsScore({ errors, indexIssues, slowQueries })
  const { avgP95, totalCalls, totalRowsRead, cacheHitRate } = useQueryInsightsMetrics(data)

  const color = HEALTH_COLORS[level]
  const label = HEALTH_LEVELS[level].label

  return (
    <div className="w-full border-b flex items-center">
      <div className="px-6 py-3 flex items-center gap-3">
        {isLoading ? (
          <QueryInsightsHealthScoreSkeleton />
        ) : (
          <QueryInsightsHealthScore score={score} color={color} label={label} />
        )}
      </div>
      <div className="flex-1 border-l h-full">
        <div className="grid grid-cols-2">
          <QueryInsightsHealthMetric
            label={$t('Average P95')}
            value={`${avgP95}ms`}
            className="border-b"
            isLoading={isLoading}
          />
          <QueryInsightsHealthMetric
            label={$t('Total Calls')}
            value={totalCalls.toLocaleString()}
            className="border-l border-b"
            isLoading={isLoading}
          />
          <QueryInsightsHealthMetric
            label={$t('Total Rows Read')}
            value={totalRowsRead.toLocaleString()}
            isLoading={isLoading}
          />
          <QueryInsightsHealthMetric
            label={$t('Cache Hit Rate')}
            value={cacheHitRate}
            className="border-l"
            isLoading={isLoading}
          />
        </div>
      </div>
    </div>
  )
}
