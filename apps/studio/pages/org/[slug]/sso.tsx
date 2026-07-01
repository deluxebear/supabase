import { useParams } from 'common'
import {
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
} from 'ui-patterns/PageHeader'

import { SSOConfig } from '@/components/interfaces/Organization/SSO/SSOConfig'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import OrganizationLayout from '@/components/layouts/OrganizationLayout'
import { OrganizationSettingsLayout } from '@/components/layouts/ProjectLayout/OrganizationSettingsLayout'
import { UnknownInterface } from '@/components/ui/UnknownInterface'
import { useIsFeatureEnabled } from '@/hooks/misc/useIsFeatureEnabled'
import { t as $t } from '@/lib/i18n'
import type { NextPageWithLayout } from '@/types'

const OrgSSO: NextPageWithLayout = () => {
  const { slug } = useParams()
  const showSsoSettings = useIsFeatureEnabled('organization:show_sso_settings')

  if (!showSsoSettings) {
    return <UnknownInterface urlBack={`/org/${slug}/general`} />
  }

  return (
    <>
      <PageHeader size="small">
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>{$t('Single Sign-On')}</PageHeaderTitle>
            <PageHeaderDescription>
              {$t('SAML SSO configuration and domain access controls')}
            </PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <SSOConfig />
    </>
  )
}

OrgSSO.getLayout = (page) => (
  <DefaultLayout>
    <OrganizationLayout title="SSO">
      <OrganizationSettingsLayout>{page}</OrganizationSettingsLayout>
    </OrganizationLayout>
  </DefaultLayout>
)

export default OrgSSO
