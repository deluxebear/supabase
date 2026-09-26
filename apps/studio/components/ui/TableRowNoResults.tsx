import { type PropsWithChildren } from 'react'
import { TableCell, TableRow } from 'ui'

import { t as $t } from '@/lib/i18n'

interface TableRowNoResultsProps {
  className?: string
  colSpan: number
  search?: string
}

export const TableRowNoResults = ({
  className,
  colSpan,
  search,
  children,
}: PropsWithChildren<TableRowNoResultsProps>) => {
  return (
    <TableRow className={className}>
      <TableCell colSpan={colSpan}>
        {children ?? (
          <>
            <p className="text-sm text-foreground">{$t('No results found')}</p>
            <p className="text-sm text-foreground-light">
              {$t('Your search for "')}
              {search}
              {$t('" did not return any results')}
            </p>
          </>
        )}
      </TableCell>
    </TableRow>
  )
}
