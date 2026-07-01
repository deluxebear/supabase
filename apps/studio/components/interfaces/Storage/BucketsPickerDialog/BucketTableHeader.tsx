import { TableHead, TableHeader, TableRow } from 'ui'

import {
  VirtualizedTableHead,
  VirtualizedTableHeader,
  VirtualizedTableRow,
} from '@/components/ui/VirtualizedTable'
import { t as $t } from '@/lib/i18n'

type BucketTableMode = 'standard' | 'virtualized'

type BucketTableHeaderProps = {
  mode: BucketTableMode
  hasBuckets?: boolean
}

export const BucketTableHeader = ({ mode, hasBuckets = true }: BucketTableHeaderProps) => {
  const BucketTableHeader = mode === 'standard' ? TableHeader : VirtualizedTableHeader
  const BucketTableRow = mode === 'standard' ? TableRow : VirtualizedTableRow
  const BucketTableHead = mode === 'standard' ? TableHead : VirtualizedTableHead

  const stickyClasses = 'sticky top-0 z-10 bg-200'

  return (
    <BucketTableHeader>
      <BucketTableRow>
        {hasBuckets && (
          <BucketTableHead className={`${stickyClasses} w-2 pr-1`}>
            <span className="sr-only">{$t('Icon')}</span>
          </BucketTableHead>
        )}
        <BucketTableHead className={stickyClasses}>{$t('Name')}</BucketTableHead>
        <BucketTableHead className={stickyClasses}>{$t('Policies')}</BucketTableHead>
        <BucketTableHead className={stickyClasses}>{$t('File size limit')}</BucketTableHead>
        <BucketTableHead className={stickyClasses}>{$t('Allowed MIME types')}</BucketTableHead>
        <BucketTableHead className={stickyClasses}>
          <span className="sr-only">{$t('Actions')}</span>
        </BucketTableHead>
      </BucketTableRow>
    </BucketTableHeader>
  )
}
