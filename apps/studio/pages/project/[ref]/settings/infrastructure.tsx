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
import { t as $t } from '@/lib/i18n'
import type { NextPageWithLayout } from '@/types'

const ProjectInfrastructure: NextPageWithLayout = () => {
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
      <InfrastructureInfo />
      <ScaffoldDivider />
      <InfrastructureActivity />
    </>
  )
}

ProjectInfrastructure.getLayout = (page) => (
  <DefaultLayout>
    <SettingsLayout title={$t('Infrastructure')}>{page}</SettingsLayout>
  </DefaultLayout>
)

export default ProjectInfrastructure
