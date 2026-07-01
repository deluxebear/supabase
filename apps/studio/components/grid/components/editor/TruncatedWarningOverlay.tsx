import { MAX_CHARACTERS } from '@supabase/pg-meta/src/query/table-row-query'
import { Button, cn } from 'ui'

import { t as $t } from '@/lib/i18n'

export const TruncatedWarningOverlay = ({
  isLoading,
  loadFullValue,
}: {
  isLoading: boolean
  loadFullValue: () => void
}) => {
  return (
    <div
      className={cn(
        'absolute top-0 left-0 flex items-center justify-center flex-col gap-y-3',
        'text-xs w-full h-full px-3 text-center',
        'bg-default/80 backdrop-blur-[1.5px]'
      )}
    >
      <div className="flex flex-col gap-y-1">
        <p>
          {$t('Value is larger than')} {MAX_CHARACTERS.toLocaleString()} characters
        </p>
        <p className="text-foreground-light">
          {$t(
            'You may try to render the entire value, but your browser may run into performance issues'
          )}
        </p>
      </div>
      <Button variant="default" loading={isLoading} onClick={loadFullValue}>
        {$t('Load full value')}
      </Button>
    </div>
  )
}
