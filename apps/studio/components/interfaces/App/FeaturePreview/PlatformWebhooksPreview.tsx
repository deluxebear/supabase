import { useParams } from 'common'

import { InlineLink } from '@/components/ui/InlineLink'
import { t as $t } from '@/lib/i18n'

export const PlatformWebhooksPreview = () => {
  const { slug = '_', ref = '_' } = useParams()

  return (
    <div className="space-y-2">
      <p className="text-sm text-foreground-light mb-4">
        {$t(
          'Configure webhook endpoints and review deliveries from both project and organization settings pages.'
        )}
      </p>
      <ul className="list-disc pl-6 text-sm text-foreground-light space-y-1">
        <li>
          {$t('Project scope:')}{' '}
          <InlineLink href={`/project/${ref}/settings/webhooks`}>
            {$t('Project Webhooks')}
          </InlineLink>
        </li>
        <li>
          {$t('Organization scope:')}{' '}
          <InlineLink href={`/org/${slug}/webhooks`}>{$t('Organization Webhooks')}</InlineLink>
        </li>
      </ul>
    </div>
  )
}
