import { PageContainer } from 'ui-patterns/PageContainer'
import {
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
} from 'ui-patterns/PageHeader'

import { ManagementTargetsSettings } from '@/components/interfaces/Organization/ManagementTargets/ManagementTargetsSettings'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import OrganizationLayout from '@/components/layouts/OrganizationLayout'
import { OrganizationSettingsLayout } from '@/components/layouts/ProjectLayout/OrganizationSettingsLayout'
import { STUDIO_CAPABILITIES, STUDIO_DEPLOYMENT_PROFILE } from '@/lib/constants/deployment-profile'
import { t as $t } from '@/lib/i18n'
import type { NextPageWithLayout } from '@/types'

const ManagementTargetsPage: NextPageWithLayout = () => {
  if (STUDIO_DEPLOYMENT_PROFILE !== 'fleet' || !STUDIO_CAPABILITIES.managementTrust) return null
  return (
    <>
      <PageHeader size="default">
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>{$t('Management Targets')}</PageHeaderTitle>
            <PageHeaderDescription>
              {$t('Configure trusted Fleet Control and Operator endpoints for this organization')}
            </PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer size="default">
        <ManagementTargetsSettings />
      </PageContainer>
    </>
  )
}

ManagementTargetsPage.getLayout = (page) => (
  <DefaultLayout>
    <OrganizationLayout title={$t('Management Targets')}>
      <OrganizationSettingsLayout>{page}</OrganizationSettingsLayout>
    </OrganizationLayout>
  </DefaultLayout>
)
export default ManagementTargetsPage
