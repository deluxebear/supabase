import { PageContainer } from 'ui-patterns/PageContainer'
import {
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
} from 'ui-patterns/PageHeader'
import { PageSection, PageSectionContent } from 'ui-patterns/PageSection'

import { EnumeratedTypes } from '@/components/interfaces/Database/EnumeratedTypes/EnumeratedTypes'
import DatabaseLayout from '@/components/layouts/DatabaseLayout/DatabaseLayout'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import { t as $t } from '@/lib/i18n'
import type { NextPageWithLayout } from '@/types'

const DatabaseEnumeratedTypes: NextPageWithLayout = () => {
  return (
    <>
      <PageHeader size="large">
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>{$t('Database Enumerated Types')}</PageHeaderTitle>
            <PageHeaderDescription>
              {$t('Custom data types that you can use in your database tables or functions')}
            </PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer size="large">
        <PageSection>
          <PageSectionContent>
            <EnumeratedTypes />
          </PageSectionContent>
        </PageSection>
      </PageContainer>
    </>
  )
}

DatabaseEnumeratedTypes.getLayout = (page) => (
  <DefaultLayout>
    <DatabaseLayout title={$t('Enumerated Types')}>{page}</DatabaseLayout>
  </DefaultLayout>
)

export default DatabaseEnumeratedTypes
