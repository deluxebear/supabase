import { useParams } from 'common'
import Image from 'next/image'

import { InlineLink } from '@/components/ui/InlineLink'
import { BASE_PATH } from '@/lib/constants'
import { t as $t } from '@/lib/i18n'

export const UnifiedLogsPreview = () => {
  const { ref = '_' } = useParams()

  return (
    <div className="space-y-2">
      <p className="text-foreground-light text-sm mb-4">
        {$t(
          'Experience our enhanced Logs interface with improved filtering, real-time updates, and a unified view across all your services. Built for better performance and easier debugging.'
        )}
      </p>
      <Image
        alt="new-logs-preview"
        src={`${BASE_PATH}/img/previews/new-logs-preview.png`}
        width={1296}
        height={900}
        className="rounded-sm border mb-4"
      />

      <div className="space-y-2 mt-4!">
        <p className="text-sm">{$t('Enabling this preview will:')}</p>
        <ul className="list-disc pl-6 text-sm text-foreground-light space-y-1">
          <li>
            {$t('Replace the current Logs interface on the')}{' '}
            <InlineLink href={`/project/${ref}/logs`}>{$t('Logs page')}</InlineLink>{' '}
            {$t('with a unified view')}
          </li>
          <li>{$t('Provide enhanced filtering capabilities and real-time log streaming')}</li>
          <li>{$t('Improve performance with optimized data loading and virtualization')}</li>
          <li>{$t('Offer a more modern interface with better search and navigation')}</li>
        </ul>
      </div>
    </div>
  )
}
