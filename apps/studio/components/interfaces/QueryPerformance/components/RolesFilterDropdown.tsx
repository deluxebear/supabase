import { useRolesFilter, type RoleWithDescription } from '../hooks/useRolesFilter'
import { RoleTooltip } from './RoleTooltip'
import { FilterPopover } from '@/components/ui/FilterPopover'
import { t as $t, translateDisplayValue as $tValue } from '@/lib/i18n'

interface RolesFilterDropdownProps {
  activeOptions: string[]
  onSaveFilters: (options: string[]) => void
  className?: string
}

export const RolesFilterDropdown = ({
  activeOptions,
  onSaveFilters,
  className,
}: RolesFilterDropdownProps) => {
  const { roles, roleGroups, isLoadingRoles } = useRolesFilter()

  const renderLabel = (option: RoleWithDescription, value: string) => (
    <RoleTooltip
      htmlFor={value}
      label={option.displayName}
      description={$tValue(option.description)}
    />
  )

  return (
    <FilterPopover
      name={$t('Roles')}
      options={roles}
      labelKey="displayName"
      valueKey="name"
      activeOptions={isLoadingRoles ? [] : activeOptions}
      onSaveFilters={onSaveFilters}
      className={className || 'w-60'}
      groups={roleGroups}
      renderLabel={renderLabel}
    />
  )
}
