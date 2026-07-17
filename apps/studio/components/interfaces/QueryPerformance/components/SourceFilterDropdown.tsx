import { FilterPopover } from '@/components/ui/FilterPopover'
import { t as $t } from '@/lib/i18n'

interface SourceFilterDropdownProps {
  activeOptions: string[]
  onSaveFilters: (options: string[]) => void
  className?: string
}

export const SourceFilterDropdown = ({
  activeOptions,
  onSaveFilters,
  className,
}: SourceFilterDropdownProps) => {
  const sources = [
    {
      name: 'dashboard',
      displayName: $t('Dashboard'),
    },
    {
      name: 'non-dashboard',
      displayName: $t('Non-dashboard'),
    },
  ]

  return (
    <FilterPopover
      name={$t('Source')}
      options={sources}
      valueKey="name"
      labelKey="displayName"
      activeOptions={activeOptions}
      onSaveFilters={onSaveFilters}
      className={className || 'w-60'}
    />
  )
}
