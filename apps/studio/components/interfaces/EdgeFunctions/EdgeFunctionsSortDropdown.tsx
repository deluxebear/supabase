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

export const EDGE_FUNCTIONS_SORT_VALUES = [
  'name:asc',
  'name:desc',
  'created_at:asc',
  'created_at:desc',
  'updated_at:asc',
  'updated_at:desc',
] as const

export type EdgeFunctionsSort = (typeof EDGE_FUNCTIONS_SORT_VALUES)[number]
export type EdgeFunctionsSortColumn = EdgeFunctionsSort extends `${infer Column}:${string}`
  ? Column
  : unknown
export type EdgeFunctionsSortOrder = EdgeFunctionsSort extends `${string}:${infer Order}`
  ? Order
  : unknown

interface EdgeFunctionsSortDropdownProps {
  value: EdgeFunctionsSort
  onChange: (value: EdgeFunctionsSort) => void
}

function getSortLabel(value: EdgeFunctionsSort) {
  const [sortCol] = value.split(':')
  return sortCol.replace('_', ' ')
}

export const EdgeFunctionsSortDropdown = ({ value, onChange }: EdgeFunctionsSortDropdownProps) => {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="default"
          icon={
            value.includes('desc') ? (
              <ArrowDownWideNarrow size={14} />
            ) : (
              <ArrowDownNarrowWide size={14} />
            )
          }
        >
          {$t('Sorted by')} {getSortLabel(value)}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(val) => onChange(val as EdgeFunctionsSort)}
        >
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>{$t('Sort by name')}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioItem value="name:asc">{$t('Ascending')}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="name:desc">{$t('Descending')}</DropdownMenuRadioItem>
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
            <DropdownMenuSubTrigger>{$t('Sort by updated at')}</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuRadioItem value="updated_at:asc">
                {$t('Ascending')}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="updated_at:desc">
                {$t('Descending')}
              </DropdownMenuRadioItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
