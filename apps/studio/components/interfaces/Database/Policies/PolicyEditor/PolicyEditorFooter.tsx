import { noop } from 'lodash'
import { Button, DialogFooter } from 'ui'

import { t as $t } from '@/lib/i18n'

interface PolicyEditorFooterProps {
  showTemplates: boolean
  onViewTemplates: () => void
  onReviewPolicy: () => void
}

const PolicyEditorFooter = ({
  showTemplates,
  onViewTemplates = noop,
  onReviewPolicy = noop,
}: PolicyEditorFooterProps) => (
  <DialogFooter>
    {showTemplates && (
      <Button variant="default" onClick={onViewTemplates}>
        {$t('View templates')}
      </Button>
    )}
    <Button variant="primary" onClick={onReviewPolicy}>
      {$t('Review')}
    </Button>
  </DialogFooter>
)

export default PolicyEditorFooter
