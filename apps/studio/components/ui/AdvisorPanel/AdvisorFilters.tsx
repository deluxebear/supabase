import { X } from 'lucide-react'
import { Tabs, TabsList, TabsTrigger } from 'ui'

import { ButtonTooltip } from '@/components/ui/ButtonTooltip'
import { FilterPopover } from '@/components/ui/FilterPopover'
import { t as $t } from '@/lib/i18n'
import { AdvisorSeverity, AdvisorTab } from '@/state/advisor-state'

interface AdvisorFiltersProps {
  activeTab: AdvisorTab
  onTabChange: (tab: string) => void
  severityFilters: AdvisorSeverity[]
  onSeverityFiltersChange: (filters: AdvisorSeverity[]) => void
  statusFilters: string[]
  onStatusFiltersChange: (filters: string[]) => void
  onClose: () => void
  isPlatform?: boolean
}

export const AdvisorFilters = ({
  activeTab,
  onTabChange,
  severityFilters,
  onSeverityFiltersChange,
  statusFilters,
  onStatusFiltersChange,
  onClose,
  isPlatform = false,
}: AdvisorFiltersProps) => {
  // Defined in render scope (not module scope) so $t() resolves against the
  // active locale — the panel remounts on locale change (I18nProvider key).
  const severityOptions = [
    { label: $t('Critical'), value: 'critical' },
    { label: $t('Warning'), value: 'warning' },
    { label: $t('Info'), value: 'info' },
  ]

  const statusOptions = [
    { label: $t('Unread'), value: 'unread' },
    { label: $t('Archived'), value: 'archived' },
  ]

  return (
    <div className="border-b overflow-x-auto">
      <div className="flex items-center justify-between gap-x-4 h-[calc(var(--header-height)-1px)]">
        <Tabs value={activeTab} onValueChange={onTabChange} className="h-full pl-4">
          <TabsList className="border-b-0 gap-4 h-full">
            <TabsTrigger value="all" className="h-full text-xs">
              {$t('All')}
            </TabsTrigger>
            <TabsTrigger value="security" className="h-full text-xs">
              {$t('Security')}
            </TabsTrigger>
            <TabsTrigger value="performance" className="h-full text-xs">
              {$t('Performance')}
            </TabsTrigger>
            {isPlatform && (
              <TabsTrigger value="messages" className="h-full text-xs flex items-center gap-2">
                {$t('Messages')}
              </TabsTrigger>
            )}
          </TabsList>
        </Tabs>
        <div className="flex items-center gap-x-2 pr-3">
          {isPlatform && (
            <FilterPopover
              name={$t('Status')}
              options={statusOptions}
              activeOptions={[...statusFilters]}
              valueKey="value"
              labelKey="label"
              isMinimized={true}
              onSaveFilters={onStatusFiltersChange}
            />
          )}
          <FilterPopover
            name={$t('Severity')}
            options={severityOptions}
            activeOptions={[...severityFilters]}
            valueKey="value"
            labelKey="label"
            isMinimized={true}
            onSaveFilters={(values) => {
              onSeverityFiltersChange(values as AdvisorSeverity[])
            }}
          />
          <ButtonTooltip
            variant="text"
            className="w-7 h-7 p-0"
            icon={<X strokeWidth={1.5} />}
            onClick={onClose}
            tooltip={{ content: { side: 'bottom', text: $t('Close Advisor Center') } }}
          />
        </div>
      </div>
    </div>
  )
}
