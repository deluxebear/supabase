import { Badge } from 'ui'
import {
  PageSection,
  PageSectionAside,
  PageSectionContent,
  PageSectionDescription,
  PageSectionMeta,
  PageSectionSummary,
  PageSectionTitle,
} from 'ui-patterns/PageSection'

import { CustomAuthProvidersList } from './CustomAuthProvidersList'
import { DocsButton } from '@/components/ui/DocsButton'
import { DOCS_URL } from '@/lib/constants'
import { t as $t } from '@/lib/i18n'

export const CustomAuthProviders = () => {
  return (
    <PageSection id="custom-providers">
      <PageSectionMeta>
        <PageSectionSummary>
          <div className="flex items-center gap-x-2">
            <PageSectionTitle>{$t('Custom Providers')}</PageSectionTitle>
            <Badge variant="success">{$t('New')}</Badge>
          </div>
          <PageSectionDescription>
            {$t(
              'Configure OAuth/OIDC providers for this project using your own issuer or endpoints.'
            )}
          </PageSectionDescription>
        </PageSectionSummary>
        <PageSectionAside>
          <DocsButton href={`${DOCS_URL}/guides/auth/custom-oauth-providers`} />
        </PageSectionAside>
      </PageSectionMeta>
      <PageSectionContent>
        <CustomAuthProvidersList />
      </PageSectionContent>
    </PageSection>
  )
}
