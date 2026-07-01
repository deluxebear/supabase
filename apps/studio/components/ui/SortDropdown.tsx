import { ArrowDownNarrowWide, ArrowDownWideNarrow } from 'lucide-react'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from 'ui'

import { t as $t } from '@/lib/i18n'

type SortOption = {
  label: string
  value: string
}

interface SortDropdownProps {
  options: SortOption[]
  value: string
  setValue: (value: string) => void
}

export const SortDropdown = ({ options, value, setValue }: SortDropdownProps) => {
  const [sortColumn, sortOrder] = value.split('_')
  const columnLabel = options.find((x) => x.value === sortColumn)?.label

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="default"
          icon={sortOrder === 'desc' ? <ArrowDownWideNarrow /> : <ArrowDownNarrowWide />}
        >
          {$t('Sorted by')} {columnLabel ?? sortColumn}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent className="w-44" align="start">
        <DropdownMenuRadioGroup value={value} onValueChange={setValue}>
          {options.map((option) => {
            return (
              <DropdownMenuSub key={option.value}>
                <DropdownMenuSubTrigger>
                  {$t('Sort by')} {option.label}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuRadioItem value={`${option.value}_asc`}>
                    {$t('Ascending')}
                  </DropdownMenuRadioItem>
                  <DropdownMenuRadioItem value={`${option.value}_desc`}>
                    {$t('Descending')}
                  </DropdownMenuRadioItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
