import { DiskManagementForm } from '@/components/interfaces/DiskManagement/DiskManagementForm'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import SettingsLayout from '@/components/layouts/ProjectSettingsLayout/SettingsLayout'
import {
  ScaffoldContainer,
  ScaffoldDescription,
  ScaffoldHeader,
  ScaffoldTitle,
} from '@/components/layouts/Scaffold'
import { t as $t } from '@/lib/i18n'
import type { NextPageWithLayout } from '@/types'

const AuthSettings: NextPageWithLayout = () => {
  return (
    <>
      <ScaffoldContainer>
        <ScaffoldHeader>
          <ScaffoldTitle>{$t('Compute and Disk')}</ScaffoldTitle>
          <ScaffoldDescription>
            {$t('Configure the compute and disk settings for your project.')}
          </ScaffoldDescription>
        </ScaffoldHeader>
      </ScaffoldContainer>
      <DiskManagementForm />
    </>
  )
}

AuthSettings.getLayout = (page) => (
  <DefaultLayout>
    <SettingsLayout title={$t('Compute and Disk')}>{page}</SettingsLayout>
  </DefaultLayout>
)
export default AuthSettings
