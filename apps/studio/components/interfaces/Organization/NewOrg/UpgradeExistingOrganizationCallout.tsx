import { Admonition } from 'ui-patterns/admonition'

import { InlineLink } from '@/components/ui/InlineLink'
import Panel from '@/components/ui/Panel'
import { DOCS_URL } from '@/lib/constants'
import { t as $t } from '@/lib/i18n'

export const UpgradeExistingOrganizationCallout = () => {
  return (
    <Panel.Content>
      <Admonition
        type="default"
        title={$t('Looking to upgrade an existing project?')}
        description={
          <div>
            <p className="text-sm text-foreground-light">
              {$t('Supabase')}{' '}
              <InlineLink href={`${DOCS_URL}/guides/platform/billing-on-supabase`}>
                {$t('bills per organization')}
              </InlineLink>
              {$t('. If you want to upgrade your existing projects,')}{' '}
              <InlineLink href="/org/_/billing?panel=subscriptionPlan">
                {$t('upgrade your existing organization')}
              </InlineLink>{' '}
              instead.
            </p>
          </div>
        }
      />
    </Panel.Content>
  )
}
