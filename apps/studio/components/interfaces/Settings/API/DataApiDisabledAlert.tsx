import { Alert, AlertDescription, AlertTitle, WarningIcon } from 'ui'

import { t as $t } from '@/lib/i18n'

export const DataApiDisabledAlert = () => {
  return (
    <Alert variant="warning">
      <WarningIcon />
      <AlertTitle>{$t('No schemas can be queried')}</AlertTitle>
      <AlertDescription>
        <p>
          {$t(
            'With this setting disabled, you will not be able to query any schemas via the Data API.'
          )}
        </p>
        <p>
          {$t('You will see errors from the Postgrest endpoint')}{' '}
          <code className="text-code-inline">/rest/v1/</code>.
        </p>
      </AlertDescription>
    </Alert>
  )
}
