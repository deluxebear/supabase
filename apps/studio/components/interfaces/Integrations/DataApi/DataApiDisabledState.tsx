import { useParams } from 'common'
import { AlertCircle } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from 'ui'

import { InlineLink } from '@/components/ui/InlineLink'
import { t as $t } from '@/lib/i18n'

interface DataApiDisabledStateProps {
  description: string
}

export const DataApiDisabledState = ({ description }: DataApiDisabledStateProps) => {
  const { ref: projectRef } = useParams()

  return (
    <div className="flex w-full p-10">
      <Alert className="max-w-md mx-auto">
        <AlertCircle size={16} />
        <AlertTitle>{$t('Data API is disabled')}</AlertTitle>
        <AlertDescription>
          {$t('Enable the Data API in the')}{' '}
          <InlineLink href={`/project/${projectRef}/integrations/data_api/overview`}>
            {$t('Overview')}
          </InlineLink>{' '}
          {$t('tab to')} {description}.
        </AlertDescription>
      </Alert>
    </div>
  )
}
