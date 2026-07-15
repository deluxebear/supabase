import { IS_PLATFORM } from 'common'
import { PageContainer } from 'ui-patterns/PageContainer'
import {
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
} from 'ui-patterns/PageHeader'

import { subscriptionHasHipaaAddon } from '@/components/interfaces/Billing/Subscription/Subscription.utils'
import { SelfPlatformAttachmentStatusPanel } from '@/components/interfaces/SelfPlatform/SelfPlatformAttachmentStatusPanel'
import { SelfPlatformConnectionPanel } from '@/components/interfaces/SelfPlatform/SelfPlatformConnectionPanel'
import { SelfPlatformDeleteProjectPanel } from '@/components/interfaces/SelfPlatform/SelfPlatformDeleteProjectPanel'
import { ComplianceConfig } from '@/components/interfaces/Settings/General/ComplianceConfig/ProjectComplianceMode'
import { CustomDomainConfig } from '@/components/interfaces/Settings/General/CustomDomainConfig/CustomDomainConfig'
import { DeleteBranchPanel } from '@/components/interfaces/Settings/General/DeleteBranchPanel'
import { DeleteProjectPanel } from '@/components/interfaces/Settings/General/DeleteProjectPanel/DeleteProjectPanel'
import { General } from '@/components/interfaces/Settings/General/General'
import { Project } from '@/components/interfaces/Settings/General/Project'
import { TransferProjectPanel } from '@/components/interfaces/Settings/General/TransferProjectPanel/TransferProjectPanel'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import SettingsLayout from '@/components/layouts/ProjectSettingsLayout/SettingsLayout'
import { useOrgSubscriptionQuery } from '@/data/subscriptions/org-subscription-query'
import { useIsFeatureEnabled } from '@/hooks/misc/useIsFeatureEnabled'
import { useSelectedOrganizationQuery } from '@/hooks/misc/useSelectedOrganization'
import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'
import { STUDIO_DEPLOYMENT_PROFILE } from '@/lib/constants/deployment-profile'
import { t as $t } from '@/lib/i18n'
import type { NextPageWithLayout } from '@/types'

const ProjectSettings: NextPageWithLayout = () => {
  const { data: project } = useSelectedProjectQuery()
  const { data: selectedOrganization } = useSelectedOrganizationQuery()

  const isBranch = !!project?.parent_project_ref
  const { projectsTransfer: projectTransferEnabled, projectSettingsCustomDomains } =
    useIsFeatureEnabled(['projects:transfer', 'project_settings:custom_domains'])

  const { data: subscription } = useOrgSubscriptionQuery(
    { orgSlug: selectedOrganization?.slug },
    { enabled: IS_PLATFORM }
  )
  const hasHipaaAddon = subscriptionHasHipaaAddon(subscription)
  const isFleet = STUDIO_DEPLOYMENT_PROFILE === 'fleet'

  return (
    <>
      <PageHeader size="small">
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>{$t('Project Settings')}</PageHeaderTitle>
            <PageHeaderDescription>
              {$t('General configuration, domains, ownership, and lifecycle')}
            </PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer size="small">
        <General />
        {isFleet && (
          <>
            <SelfPlatformAttachmentStatusPanel />
            <SelfPlatformConnectionPanel />
            <SelfPlatformDeleteProjectPanel />
          </>
        )}
        {IS_PLATFORM && !isFleet && (
          <>
            <Project />
            {/* this is only settable on compliance orgs, currently that means HIPAA orgs */}
            {!isBranch && hasHipaaAddon && <ComplianceConfig />}
            {projectSettingsCustomDomains && <CustomDomainConfig />}
            {!isBranch && projectTransferEnabled && <TransferProjectPanel />}
            {isBranch ? <DeleteBranchPanel /> : <DeleteProjectPanel />}
          </>
        )}
      </PageContainer>
    </>
  )
}

ProjectSettings.getLayout = (page) => (
  <DefaultLayout>
    <SettingsLayout title={$t('General')}>{page}</SettingsLayout>
  </DefaultLayout>
)
export default ProjectSettings
