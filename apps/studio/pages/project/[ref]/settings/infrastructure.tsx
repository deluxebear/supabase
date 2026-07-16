import { SelfPlatformLifecyclePanel } from '@/components/interfaces/SelfPlatform/SelfPlatformLifecyclePanel'
import { FleetInfrastructure } from '@/components/interfaces/Settings/Infrastructure/FleetInfrastructure'
import { InfrastructureActivity } from '@/components/interfaces/Settings/Infrastructure/InfrastructureActivity'
import { InfrastructureInfo } from '@/components/interfaces/Settings/Infrastructure/InfrastructureInfo'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import SettingsLayout from '@/components/layouts/ProjectSettingsLayout/SettingsLayout'
import {
  ScaffoldContainer,
  ScaffoldDescription,
  ScaffoldDivider,
  ScaffoldHeader,
  ScaffoldTitle,
} from '@/components/layouts/Scaffold'
import { STUDIO_CAPABILITIES, STUDIO_DEPLOYMENT_PROFILE } from '@/lib/constants/deployment-profile'
import { t as $t } from '@/lib/i18n'
import type { NextPageWithLayout } from '@/types'

const ProjectInfrastructure: NextPageWithLayout = () => {
  const isFleet = STUDIO_DEPLOYMENT_PROFILE === 'fleet'

  return (
    <>
      <ScaffoldContainer>
        <ScaffoldHeader>
          <ScaffoldTitle>{$t('Infrastructure')}</ScaffoldTitle>
          <ScaffoldDescription>
            {$t('General information regarding your server instance')}
          </ScaffoldDescription>
        </ScaffoldHeader>
      </ScaffoldContainer>
      {!isFleet && (
        <>
          <InfrastructureInfo />
          <ScaffoldDivider />
          <InfrastructureActivity />
        </>
      )}
      {isFleet && (
        <ScaffoldContainer>
          <FleetInfrastructure />
        </ScaffoldContainer>
      )}
      {isFleet && STUDIO_CAPABILITIES.lifecycleManagement && (
        <ScaffoldContainer>
          <SelfPlatformLifecyclePanel />
        </ScaffoldContainer>
      )}
    </>
  )
}

ProjectInfrastructure.getLayout = (page) => (
  <DefaultLayout>
    <SettingsLayout title={$t('Infrastructure')}>{page}</SettingsLayout>
  </DefaultLayout>
)

export default ProjectInfrastructure
