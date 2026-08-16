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
                  {$t('View and configure compute and disk for your project.')}
                </PageHeaderDescription>
              </PageHeaderSummary>
            </PageHeaderMeta>
          </PageHeader>
          <DiskManagementForm />
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
