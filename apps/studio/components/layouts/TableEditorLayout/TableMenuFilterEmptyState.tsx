import { Button } from 'ui'
import { InnerSideBarEmptyPanel } from 'ui-patterns/InnerSideMenu'

import { t as $t } from '@/lib/i18n'

export const TableMenuFilterEmptyState = ({ onResetFilters }: { onResetFilters: () => void }) => {
  return (
    <InnerSideBarEmptyPanel
      title={$t('No results based on filters')}
      description={$t('All entity types are hidden.')}
      className="mx-4"
    >
      <Button onClick={onResetFilters} className="mt-2">
        {$t('Reset filters')}
      </Button>
    </InnerSideBarEmptyPanel>
  )
}
