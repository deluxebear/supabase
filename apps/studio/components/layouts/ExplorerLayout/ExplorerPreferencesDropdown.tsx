import { MoreVertical } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from 'ui'

import {
  explorerHomeSchema,
  useExplorerPreferences,
} from '@/components/interfaces/Account/Preferences/useExplorerPreferences'
import { ButtonTooltip } from '@/components/ui/ButtonTooltip'
import { t as $t } from '@/lib/i18n'

export const ExplorerPreferencesDropdown = () => {
  const { home, setHome, isReady } = useExplorerPreferences()

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ButtonTooltip
          size="tiny"
          variant="outline"
          aria-label={$t('Explorer preferences')}
          className="size-7 shrink-0 px-0"
          icon={<MoreVertical size={14} strokeWidth={1.5} />}
          tooltip={{ content: { side: 'bottom', text: 'Explorer preferences' } }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-44" align="end">
        <DropdownMenuLabel>{$t('Open Explorer to')}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={home}
          onValueChange={(value) => {
            const result = explorerHomeSchema.safeParse(value)
            if (result.success) setHome(result.data)
          }}
        >
          <DropdownMenuRadioItem value="home" disabled={!isReady}>
            {$t('Start page')}
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="query" disabled={!isReady}>
            {$t('SQL query')}
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
