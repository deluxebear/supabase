import { Button } from 'ui'
import { Admonition } from 'ui-patterns/admonition'

import { t as $t } from '@/lib/i18n'

interface LogsExplorerOtelBannerProps {
  isRewriting: boolean
  onRewrite: () => void
  onDismiss: () => void
}

export const LogsExplorerOtelBanner = ({
  isRewriting,
  onRewrite,
  onDismiss,
}: LogsExplorerOtelBannerProps) => {
  return (
    <Admonition
      type="default"
      layout="horizontal"
      className="mb-0 rounded-none border-x-0 border-t-0"
      title={$t('Logs now run on a ClickHouse-backed engine')}
      description={$t(
        'This query needs to be adjusted to ClickHouse SQL, which the Assistant can do for you.'
      )}
      actions={
        <div className="flex items-center gap-2">
          <Button variant="default" size="tiny" loading={isRewriting} onClick={onRewrite}>
            {$t('Rewrite with Assistant')}
          </Button>
          <Button variant="text" size="tiny" onClick={onDismiss}>
            {$t('Dismiss')}
          </Button>
        </div>
      }
    />
  )
}
