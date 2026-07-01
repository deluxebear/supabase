import { useParams } from 'common'

import { InlineLink } from '@/components/ui/InlineLink'
import { t as $t } from '@/lib/i18n'

export const JitDbAccessPreview = () => {
  const { ref = '_' } = useParams()

  return (
    <div className="space-y-4">
      <p className="text-sm text-foreground-light">
        {$t(
          'Grant project members temporary database role access through short-lived tokens, controlled in'
        )}{' '}
        <InlineLink href={`/project/${ref}/database/settings`}>
          {$t('Database Settings')}
        </InlineLink>
        .
      </p>
      <div className="space-y-2">
        <p className="text-sm">{$t('Enabling this preview will:')}</p>
        <ul className="list-disc pl-6 text-sm text-foreground-light space-y-1">
          <li>{$t('Show temporary access controls in Database Settings')}</li>
          <li>{$t('Allow configuring role grants and member-level temporary access rules')}</li>
        </ul>
      </div>
      <p className="text-sm text-foreground-light">
        {$t('The minimum Postgres version needed for this feature is 17.6.1.081 (or higher).')}
      </p>
    </div>
  )
}
