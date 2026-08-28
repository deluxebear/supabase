import { useDevToolbar } from 'dev-tools'
import { DropdownMenuCheckboxItem, DropdownMenuGroup, DropdownMenuLabel } from 'ui'

import { t as $t } from '@/lib/i18n'

export function DevToolbarMenuGroup() {
  const { isAvailable, isEnabled, enableToolbar, dismissToolbar } = useDevToolbar()

  if (!isAvailable) return null

  const handleToggleDevToolbar = (isChecked: boolean) => {
    if (isChecked) {
      enableToolbar()
      return
    }

    dismissToolbar()
  }

  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel>{$t('Local tools')}</DropdownMenuLabel>
      <DropdownMenuCheckboxItem
        checked={isEnabled}
        onCheckedChange={handleToggleDevToolbar}
        className="cursor-pointer"
      >
        {$t('Dev toolbar')}
      </DropdownMenuCheckboxItem>
    </DropdownMenuGroup>
  )
}
