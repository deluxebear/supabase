import { BarChart2 } from 'lucide-react'
import { cn } from 'ui'

import { ChartHeader } from './ChartHeader'
import { useChartSize } from './Charts.utils'
import { t as $t } from '@/lib/i18n'

interface NoDataPlaceholderProps {
  title?: string
  attribute?: string
  format?: string | ((value: unknown) => string)
  message?: string
  description?: string
  className?: string
  size: Parameters<typeof useChartSize>[0]
  isFullHeight?: boolean
  titleTooltip?: string
  hideTotalPlaceholder?: boolean
  docsUrl?: string
}
const NoDataPlaceholder = ({
  attribute,
  message,
  description,
  format,
  className = '',
  size,
  isFullHeight = false,
  titleTooltip,
  hideTotalPlaceholder = false,
  docsUrl,
}: NoDataPlaceholderProps) => {
  const { minHeight } = useChartSize(size)
  const emptyMessage = message ?? $t('No data to show')

  return (
    <div className={cn(isFullHeight && 'h-full')}>
      {attribute !== undefined && (
        <ChartHeader
          title={$t(attribute)}
          format={format}
          highlightedValue={hideTotalPlaceholder ? undefined : 0}
          titleTooltip={titleTooltip ? $t(titleTooltip) : titleTooltip}
          docsUrl={docsUrl}
        />
      )}
      <div
        className={cn(
          'border-control flex grow w-full flex-col items-center justify-center space-y-2 border border-dashed text-center',
          isFullHeight && 'h-full',
          className
        )}
        // extra 20 px for the x ticks
        style={{ minHeight: minHeight + 20 }}
      >
        <BarChart2 size={20} className="text-border-stronger" />
        <div className="px-1">
          <p className="text-foreground-light text-xs">{$t(emptyMessage)}</p>
          {description && (
            <p className="text-foreground-lighter text-xs">{$t(description)}</p>
          )}
        </div>
      </div>
    </div>
  )
}
export default NoDataPlaceholder
