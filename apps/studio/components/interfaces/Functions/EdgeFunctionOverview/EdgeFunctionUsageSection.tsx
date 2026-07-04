import { useMemo } from 'react'
import { ChartMetric } from 'ui-patterns/Chart'
import { PageContainer } from 'ui-patterns/PageContainer'
import {
  PageSection,
  PageSectionContent,
  PageSectionMeta,
  PageSectionSummary,
  PageSectionTitle,
} from 'ui-patterns/PageSection'

import { getCpuTooltipDetails, getMemoryTooltipDetails } from './EdgeFunctionMetricTooltipDetails'
import {
  CPU_TIME_CHART_CONFIG,
  formatMetric,
  formatRate,
  getChartEmptyStateCopy,
  MEMORY_CHART_CONFIG,
} from './EdgeFunctionOverview.utils'
import type { EdgeFunctionChartDatum } from './EdgeFunctionOverview.utils'
import { EdgeFunctionTimeSeriesChartCard } from './EdgeFunctionTimeSeriesChartCard'
import { t as $t } from '@/lib/i18n'

interface EdgeFunctionUsageSectionProps {
  data: EdgeFunctionChartDatum[]
  dateTimeFormat: string
  isLoading: boolean
  isError: boolean
  errorMessage?: string
  averageCpuTime: number
  maxCpuTime: number
  averageMemoryUsage: number
  totalHeapMemory: number
  totalExternalMemory: number
  totalMemoryByType: number
}

export const EdgeFunctionUsageSection = ({
  data,
  dateTimeFormat,
  isLoading,
  isError,
  errorMessage,
  averageCpuTime,
  maxCpuTime,
  averageMemoryUsage,
  totalHeapMemory,
  totalExternalMemory,
  totalMemoryByType,
}: EdgeFunctionUsageSectionProps) => {
  const cpuEmptyStateCopy = getChartEmptyStateCopy('CPU time', isError, errorMessage)
  const memoryEmptyStateCopy = getChartEmptyStateCopy('memory usage', isError, errorMessage)
  const cpuTooltipDetails = useMemo(() => getCpuTooltipDetails(averageCpuTime), [averageCpuTime])
  const memoryTooltipDetails = useMemo(
    () => getMemoryTooltipDetails(averageMemoryUsage),
    [averageMemoryUsage]
  )
  const cpuMetrics = (
    <div className="flex flex-wrap gap-x-8 gap-y-4">
      <ChartMetric
        label={$t('Average CPU Time')}
        value={formatMetric(averageCpuTime, 'ms')}
        tooltip={$t('Average CPU time usage for the function')}
      />
      <ChartMetric
        label={$t('Max CPU Time')}
        value={formatMetric(maxCpuTime, 'ms')}
        tooltip={$t('Maximum CPU time usage for the function')}
      />
    </div>
  )
  const memoryMetrics = (
    <div className="flex flex-wrap gap-x-8 gap-y-4">
      <ChartMetric
        label={$t('Average Memory Usage')}
        value={formatMetric(averageMemoryUsage, 'MB')}
        tooltip={$t('Average memory usage for the function')}
      />
      <ChartMetric
        label={$t('Heap')}
        value={formatRate(totalHeapMemory, totalMemoryByType)}
        tooltip={$t('Share of memory attributed to heap usage over the selected interval')}
      />
      <ChartMetric
        label={$t('External')}
        value={formatRate(totalExternalMemory, totalMemoryByType)}
        tooltip={$t('Share of memory attributed to external usage over the selected interval')}
      />
    </div>
  )

  return (
    <PageSection>
      <PageSectionContent>
        <PageContainer size="full">
          <div className="flex flex-col gap-6">
            <PageSectionMeta>
              <PageSectionSummary>
                <PageSectionTitle>{$t('Usage')}</PageSectionTitle>
              </PageSectionSummary>
            </PageSectionMeta>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
              <EdgeFunctionTimeSeriesChartCard
                data={data}
                dateTimeFormat={dateTimeFormat}
                isLoading={isLoading}
                isError={isError}
                emptyTitle={cpuEmptyStateCopy.title}
                emptyDescription={cpuEmptyStateCopy.description}
                metrics={cpuMetrics}
                dataKey="max_cpu_time_used"
                config={CPU_TIME_CHART_CONFIG}
                tooltipDetails={cpuTooltipDetails}
                referenceLines={[
                  {
                    y: averageCpuTime,
                    label: 'average',
                    stroke: 'var(--foreground-default)',
                    strokeWidth: 1.5,
                  },
                ]}
                yAxisProps={{
                  width: 64,
                  tickFormatter: (value: number) => `${Math.round(value)}ms`,
                }}
              />

              <EdgeFunctionTimeSeriesChartCard
                data={data}
                dateTimeFormat={dateTimeFormat}
                isLoading={isLoading}
                isError={isError}
                emptyTitle={memoryEmptyStateCopy.title}
                emptyDescription={memoryEmptyStateCopy.description}
                metrics={memoryMetrics}
                dataKey="avg_memory_used"
                config={MEMORY_CHART_CONFIG}
                tooltipDetails={memoryTooltipDetails}
                referenceLines={[
                  {
                    y: averageMemoryUsage,
                    label: 'average',
                    stroke: 'var(--foreground-default)',
                    strokeWidth: 1.5,
                  },
                ]}
                yAxisProps={{
                  width: 64,
                  tickFormatter: (value: number) => `${Number(value).toFixed(1)}MB`,
                }}
              />
            </div>
          </div>
        </PageContainer>
      </PageSectionContent>
    </PageSection>
  )
}
