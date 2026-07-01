import { LogoLoader } from 'ui'
import {
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
} from 'ui-patterns/PageHeader'

import { AuditLogs } from '@/components/interfaces/Organization/AuditLogs/AuditLogs'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import OrganizationLayout from '@/components/layouts/OrganizationLayout'
import { OrganizationSettingsLayout } from '@/components/layouts/ProjectLayout/OrganizationSettingsLayout'
import { usePermissionsQuery } from '@/data/permissions/permissions-query'
import { useSelectedOrganizationQuery } from '@/hooks/misc/useSelectedOrganization'
import { t as $t } from '@/lib/i18n'
import type { NextPageWithLayout } from '@/types'

const OrgAuditLogs: NextPageWithLayout = () => {
  const { isPending: isLoadingPermissions } = usePermissionsQuery()
  const { data: selectedOrganization } = useSelectedOrganizationQuery()

  return (
    <>
      <PageHeader size="default">
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>{$t('Audit Logs')}</PageHeaderTitle>
            <PageHeaderDescription>
              {$t('Organization-level activity history and security event records')}
            </PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      {selectedOrganization === undefined && isLoadingPermissions ? <LogoLoader /> : <AuditLogs />}
    </>
  )
}

OrgAuditLogs.getLayout = (page) => (
  <DefaultLayout>
    <OrganizationLayout title={$t('Audit Logs')}>
      <OrganizationSettingsLayout>{page}</OrganizationSettingsLayout>
    </OrganizationLayout>
  </DefaultLayout>
)
export default OrgAuditLogs
