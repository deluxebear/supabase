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

import { ButtonTooltip } from '@/components/ui/ButtonTooltip'
import { t as $t } from '@/lib/i18n'

interface SortDropdownProps {
  specificFilterColumn: string
  sortColumn: string
  sortOrder: string
  sortByValue: string
  showSortByEmail: boolean
  showSortByPhone: boolean
  setSortByValue: (value: string) => void
  improvedSearchEnabled: boolean
}

/** [Joshen] To refactor to use the SortDropdown component in components/ui */
export const SortDropdown = ({
  specificFilterColumn,
  sortColumn,
  sortOrder,
  sortByValue,
  showSortByEmail,
  showSortByPhone,
  setSortByValue,
  improvedSearchEnabled = false,
}: SortDropdownProps) => {
  if (specificFilterColumn !== 'freeform' && !improvedSearchEnabled) {
    return (
      <ButtonTooltip
        disabled
        variant="default"
        icon={<ArrowDownNarrowWide />}
        tooltip={{
          content: {
            side: 'bottom',
            className: 'w-80 text-center',
            text: (
              <>
                {$t(
                  "Sorting cannot be changed when searching on a specific column. If you'd like to sort on other columns, change the search to"
                )}{' '}
                <span className="text-warning">{$t('unified search')}</span>{' '}
                {$t('from the search dropdown.')}
              </>
            ),
          },
        }}
      >
        {$t('Sorted by user ID')}
      </ButtonTooltip>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="default"
          icon={sortOrder === 'desc' ? <ArrowDownWideNarrow /> : <ArrowDownNarrowWide />}
        >
          {$t('Sorted by')} {sortColumn === 'id' ? 'user ID' : sortColumn.replaceAll('_', ' ')}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-44" align="start">
        <DropdownMenuRadioGroup value={sortByValue} onValueChange={setSortByValue}>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>{$t('Sort by user ID')}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioItem value="id:asc">{$t('Ascending')}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="id:desc">{$t('Descending')}</DropdownMenuRadioItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>{$t('Sort by created at')}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioItem value="created_at:asc">
                {$t('Ascending')}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="created_at:desc">
                {$t('Descending')}
              </DropdownMenuRadioItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>{$t('Sort by last sign in at')}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioItem value="last_sign_in_at:asc">
                {$t('Ascending')}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="last_sign_in_at:desc">
                {$t('Descending')}
              </DropdownMenuRadioItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          {showSortByEmail && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>{$t('Sort by email')}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioItem value="email:asc">{$t('Ascending')}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="email:desc">{$t('Descending')}</DropdownMenuRadioItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
          {showSortByPhone && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>{$t('Sort by phone')}</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuRadioItem value="phone:asc">{$t('Ascending')}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="phone:desc">{$t('Descending')}</DropdownMenuRadioItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
