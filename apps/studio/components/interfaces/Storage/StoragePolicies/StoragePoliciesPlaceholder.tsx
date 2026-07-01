import { Card, CardContent } from 'ui'

import { t as $t } from '@/lib/i18n'

const StoragePoliciesPlaceholder = () => (
  <Card>
    <CardContent>
      <p className="text-sm text-foreground-lighter">
        {$t('Create a bucket first to start writing policies')}
      </p>
    </CardContent>
  </Card>
)

export default StoragePoliciesPlaceholder
