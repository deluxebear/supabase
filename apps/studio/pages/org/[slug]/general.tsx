import { LogoLoader } from 'ui'
import { PageContainer } from 'ui-patterns/PageContainer'
import {
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
} from 'ui-patterns/PageHeader'

import { GeneralSettings } from '@/components/interfaces/Organization/GeneralSettings/GeneralSettings'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import OrganizationLayout from '@/components/layouts/OrganizationLayout'
import { OrganizationSettingsLayout } from '@/components/layouts/ProjectLayout/OrganizationSettingsLayout'
import { usePermissionsQuery } from '@/data/permissions/permissions-query'
import { useSelectedOrganizationQuery } from '@/hooks/misc/useSelectedOrganization'
import { t as $t } from '@/lib/i18n'
import type { NextPageWithLayout } from '@/types'

const OrgGeneralSettings: NextPageWithLayout = () => {
  const { isPending: isLoadingPermissions } = usePermissionsQuery()
  const { data: selectedOrganization } = useSelectedOrganizationQuery()

  return (
    <>
      <PageHeader size="default">
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>{$t('Organization Settings')}</PageHeaderTitle>
            <PageHeaderDescription>
              {$t('General configuration, privacy, and lifecycle controls')}
            </PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer size="default">
        {selectedOrganization === undefined && isLoadingPermissions ? (
          <LogoLoader />
        ) : (
          <GeneralSettings />
        )}
      </PageContainer>
    </>
  )
}

OrgGeneralSettings.getLayout = (page) => (
  <DefaultLayout>
    <OrganizationLayout title={$t('General')}>
      <OrganizationSettingsLayout>{page}</OrganizationSettingsLayout>
    </OrganizationLayout>
  </DefaultLayout>
)
export default OrgGeneralSettings
