import { PageContainer } from 'ui-patterns/PageContainer'
import {
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
} from 'ui-patterns/PageHeader'
import { PageSection, PageSectionContent } from 'ui-patterns/PageSection'

import { ConfigurationDriftPage } from '@/components/interfaces/ConfigDrift/ConfigurationDriftPage'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import SettingsLayout from '@/components/layouts/ProjectSettingsLayout/SettingsLayout'
import { t as $t } from '@/lib/i18n'
import type { NextPageWithLayout } from '@/types'

const ConfigurationDriftPageEntry: NextPageWithLayout = () => {
  return (
    <>
      <PageHeader size="small">
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>{$t('Code configuration')}</PageHeaderTitle>
            <PageHeaderDescription>
              {$t(
                'Compare the live project configuration with supabase/config.toml on this branch'
              )}
            </PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer size="small">
        <PageSection>
          <PageSectionContent>
            <ConfigurationDriftPage />
          </PageSectionContent>
        </PageSection>
      </PageContainer>
    </>
  )
}

ConfigurationDriftPageEntry.getLayout = (page) => (
  <DefaultLayout>
    <SettingsLayout title={$t('Code configuration')}>{page}</SettingsLayout>
  </DefaultLayout>
)

export default ConfigurationDriftPageEntry
