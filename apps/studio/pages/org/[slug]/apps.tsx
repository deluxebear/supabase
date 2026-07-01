import {
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
} from 'ui-patterns/PageHeader'

import { OAuthApps } from '@/components/interfaces/Organization/OAuthApps/OAuthApps'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import OrganizationLayout from '@/components/layouts/OrganizationLayout'
import { OrganizationSettingsLayout } from '@/components/layouts/ProjectLayout/OrganizationSettingsLayout'
import { t as $t } from '@/lib/i18n'
import type { NextPageWithLayout } from '@/types'

const OrgOAuthApps: NextPageWithLayout = () => {
  return (
    <>
      <PageHeader size="default">
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>{$t('OAuth Apps')}</PageHeaderTitle>
            <PageHeaderDescription>
              {$t('Published and authorized OAuth applications')}
            </PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <OAuthApps />
    </>
  )
}

OrgOAuthApps.getLayout = (page) => (
  <DefaultLayout>
    <OrganizationLayout title={$t('OAuth Apps')}>
      <OrganizationSettingsLayout>{page}</OrganizationSettingsLayout>
    </OrganizationLayout>
  </DefaultLayout>
)
export default OrgOAuthApps
