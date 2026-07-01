import type { PGColumn, PGTable } from '@supabase/pg-meta'

import { t as $t } from '@/lib/i18n'
import type { DeepReadonly } from '@/lib/type-helpers'

interface Props {
  table: PGTable
  column?: DeepReadonly<PGColumn>
}

export const HeaderTitle = ({ table, column }: Props) => {
  if (!column) {
    return (
      <>
        <span>{$t('Add new column to')}</span>
        <code className="text-code-inline text-sm! ml-1">{table.name}</code>
      </>
    )
  }
  return (
    <>
      {$t('Update column')} <code className="text-code-inline text-sm!">{column.name}</code> from{' '}
      <code className="text-code-inline text-sm!">{column.table}</code>
    </>
  )
}
