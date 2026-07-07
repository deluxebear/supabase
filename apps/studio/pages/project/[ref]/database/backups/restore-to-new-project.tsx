import { useParams } from 'common'
import { PageContainer } from 'ui-patterns/PageContainer'
import {
  PageHeader,
  PageHeaderMeta,
  PageHeaderNavigationTabs,
  PageHeaderSummary,
  PageHeaderTitle,
} from 'ui-patterns/PageHeader'
import { PageSection, PageSectionContent } from 'ui-patterns/PageSection'

import DatabaseBackupsNav from '@/components/interfaces/Database/Backups/DatabaseBackupsNav'
import { RestoreToNewProject } from '@/components/interfaces/Database/RestoreToNewProject/RestoreToNewProject'
import DatabaseLayout from '@/components/layouts/DatabaseLayout/DatabaseLayout'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import { UnknownInterface } from '@/components/ui/UnknownInterface'
import { useIsFeatureEnabled } from '@/hooks/misc/useIsFeatureEnabled'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'
import { t as $t } from '@/lib/i18n'
import type { NextPageWithLayout } from '@/types'

const RestoreToNewProjectPage: NextPageWithLayout = () => {
  const { ref } = useParams()
  const { databaseRestoreToNewProject } = useIsFeatureEnabled(['database:restore_to_new_project'])

  if (!databaseRestoreToNewProject || IS_SELF_PLATFORM) {
    return <UnknownInterface urlBack={`/project/${ref}/database/backups/scheduled`} />
  }

  return (
    <>
      <PageHeader>
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>{$t('Database Backups')}</PageHeaderTitle>
          </PageHeaderSummary>
        </PageHeaderMeta>
        <PageHeaderNavigationTabs>
          <DatabaseBackupsNav active="rtnp" />
        </PageHeaderNavigationTabs>
      </PageHeader>
      <PageContainer>
        <PageSection>
          <PageSectionContent>
            <div className="space-y-8">
              <RestoreToNewProject />
            </div>
          </PageSectionContent>
        </PageSection>
      </PageContainer>
    </>
  )
}

RestoreToNewProjectPage.getLayout = (page) => (
  <DefaultLayout>
    <DatabaseLayout title={$t('Backups')}>{page}</DatabaseLayout>
  </DefaultLayout>
)

export default RestoreToNewProjectPage
