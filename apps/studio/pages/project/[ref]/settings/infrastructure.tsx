import { useState } from 'react'
import {
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
} from 'ui-patterns/PageHeader'

import { DiskManagementForm } from '@/components/interfaces/DiskManagement/DiskManagementForm'
import { SelfPlatformLifecyclePanel } from '@/components/interfaces/SelfPlatform/SelfPlatformLifecyclePanel'
import { FleetInfrastructure } from '@/components/interfaces/Settings/Infrastructure/FleetInfrastructure'
import { InfrastructureTopology } from '@/components/interfaces/Settings/Infrastructure/InfrastructureTopology'
import { ReadReplicasSection } from '@/components/interfaces/Settings/Infrastructure/ReadReplicas/ReadReplicasSection'
import type { RecommendedComputeForReadReplicas } from '@/components/interfaces/Settings/Infrastructure/ReadReplicas/recommendCompute'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import SettingsLayout from '@/components/layouts/ProjectSettingsLayout/SettingsLayout'
import {
  ScaffoldContainer,
  ScaffoldDescription,
  ScaffoldHeader,
  ScaffoldTitle,
} from '@/components/layouts/Scaffold'
import { STUDIO_CAPABILITIES, STUDIO_DEPLOYMENT_PROFILE } from '@/lib/constants/deployment-profile'
import { t as $t } from '@/lib/i18n'
import type { NextPageWithLayout } from '@/types'

const InfrastructureSettings: NextPageWithLayout = () => {
  const isFleet = STUDIO_DEPLOYMENT_PROFILE === 'fleet'
  const [recommendedCompute, setRecommendedCompute] =
    useState<RecommendedComputeForReadReplicas | null>(null)

  return (
    <>
      {isFleet && (
        <>
          <ScaffoldContainer>
            <ScaffoldHeader>
              <ScaffoldTitle>{$t('Infrastructure')}</ScaffoldTitle>
              <ScaffoldDescription>
                {$t('General information regarding your server instance')}
              </ScaffoldDescription>
            </ScaffoldHeader>
          </ScaffoldContainer>
          <ScaffoldContainer>
            <FleetInfrastructure />
          </ScaffoldContainer>
          {STUDIO_CAPABILITIES.lifecycleManagement && (
            <ScaffoldContainer>
              <SelfPlatformLifecyclePanel />
            </ScaffoldContainer>
          )}
        </>
      )}
      {!isFleet && (
        <>
          <PageHeader size="default">
            <PageHeaderMeta>
              <PageHeaderSummary>
                <PageHeaderTitle>{$t('Infrastructure')}</PageHeaderTitle>
                <PageHeaderDescription>
                  {$t('Configure compute, disk, and read replicas for your project.')}
                </PageHeaderDescription>
              </PageHeaderSummary>
            </PageHeaderMeta>
          </PageHeader>
          <DiskManagementForm
            overviewExtra={<InfrastructureTopology />}
            beforeScaling={<ReadReplicasSection onRecommendCompute={setRecommendedCompute} />}
            recommendedCompute={recommendedCompute}
            onRecommendedComputeApplied={() => setRecommendedCompute(null)}
          />
        </>
      )}
    </>
  )
}

InfrastructureSettings.getLayout = (page) => (
  <DefaultLayout>
    <SettingsLayout title={'Infrastructure'}>{page}</SettingsLayout>
  </DefaultLayout>
)
export default InfrastructureSettings
