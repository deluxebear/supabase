import {
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
} from 'ui-patterns/PageHeader'

import { Addons } from '@/components/interfaces/Settings/Addons/Addons'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import SettingsLayout from '@/components/layouts/ProjectSettingsLayout/SettingsLayout'
import { t as $t } from '@/lib/i18n'
import type { NextPageWithLayout } from '@/types'

const ProjectAddons: NextPageWithLayout = () => {
  return (
    <>
      <PageHeader size="default">
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>{$t('Add-ons')}</PageHeaderTitle>
            <PageHeaderDescription>
              {$t('Level up your project with add-ons')}
            </PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <Addons />
    </>
  )
}

ProjectAddons.getLayout = (page) => (
  <DefaultLayout>
    <SettingsLayout title={$t('Add-ons')}>{page}</SettingsLayout>
  </DefaultLayout>
)
export default ProjectAddons
