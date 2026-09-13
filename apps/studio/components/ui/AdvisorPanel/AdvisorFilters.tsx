import { X } from 'lucide-react'
import { z } from 'zod'

import { advisorCategoryLabels } from './AdvisorPanel.utils'
import { ButtonTooltip } from '@/components/ui/ButtonTooltip'
import { FilterPopover } from '@/components/ui/FilterPopover'
import { t as $t } from '@/lib/i18n'
import {
  AdvisorCategory,
  advisorCategorySchema,
  AdvisorSeverity,
  advisorSeveritySchema,
} from '@/state/advisor-state'

/**
 * FilterPopover reports its selection as plain strings, so validate them against the
 * schema before they flow back into typed state. Unrecognized values are dropped rather
 * than throwing — a stale option should not take the panel down.
 */
const parseFilterValues = <T extends string>(schema: z.ZodType<T>, values: string[]): T[] =>
  values.flatMap((value) => {
    const result = schema.safeParse(value)
    return result.success ? [result.data] : []
  })

const platformCategories: AdvisorCategory[] = ['security', 'performance', 'health', 'messages']
// Health runs against platform infrastructure and messages are platform notifications
const selfHostedCategories: AdvisorCategory[] = ['security', 'performance']

const severityOptions = [
  { label: 'Critical', value: 'critical' },
  { label: 'Warning', value: 'warning' },
  { label: 'Info', value: 'info' },
]

const statusOptions = [
  { label: 'Unread', value: 'unread' },
  { label: 'Archived', value: 'archived' },
]

interface AdvisorFiltersProps {
  categoryFilters: AdvisorCategory[]
  onCategoryFiltersChange: (filters: AdvisorCategory[]) => void
  severityFilters: AdvisorSeverity[]
  onSeverityFiltersChange: (filters: AdvisorSeverity[]) => void
  statusFilters: string[]
  onStatusFiltersChange: (filters: string[]) => void
  onClose: () => void
  isPlatform?: boolean
}

export const AdvisorFilters = ({
  categoryFilters,
  onCategoryFiltersChange,
  severityFilters,
  onSeverityFiltersChange,
  statusFilters,
  onStatusFiltersChange,
  onClose,
  isPlatform = false,
}: AdvisorFiltersProps) => {
  const categoryOptions = (isPlatform ? platformCategories : selfHostedCategories).map(
    (category) => ({ label: $t(advisorCategoryLabels[category]), value: category })
  )
  const translatedSeverityOptions = severityOptions.map((option) => ({
    ...option,
    label: $t(option.label),
  }))
  const translatedStatusOptions = statusOptions.map((option) => ({
    ...option,
    label: $t(option.label),
  }))

  return (
    <div className="border-b overflow-x-auto">
      <div className="flex items-center justify-between gap-x-4 h-[calc(var(--header-height)-1px)]">
        <div className="flex items-center gap-x-2 pl-3">
          <FilterPopover
            name="Category"
            options={categoryOptions}
            activeOptions={[...categoryFilters]}
            valueKey="value"
            labelKey="label"
            isMinimized={true}
            onSaveFilters={(values) => {
              onCategoryFiltersChange(parseFilterValues(advisorCategorySchema, values))
            }}
          />
          {isPlatform && (
            <FilterPopover
              name="Status"
              options={translatedStatusOptions}
              activeOptions={[...statusFilters]}
              valueKey="value"
              labelKey="label"
              isMinimized={true}
              onSaveFilters={onStatusFiltersChange}
            />
          )}
          <FilterPopover
            name="Severity"
            options={translatedSeverityOptions}
            activeOptions={[...severityFilters]}
            valueKey="value"
            labelKey="label"
            isMinimized={true}
            onSaveFilters={(values) => {
              onSeverityFiltersChange(parseFilterValues(advisorSeveritySchema, values))
            }}
          />
        </div>
        <ButtonTooltip
          variant="text"
          className="w-7 h-7 p-0 mr-3"
          icon={<X strokeWidth={1.5} />}
          onClick={onClose}
          tooltip={{ content: { side: 'bottom', text: 'Close Advisor Center' } }}
        />
      </div>
    </div>
  )
}
