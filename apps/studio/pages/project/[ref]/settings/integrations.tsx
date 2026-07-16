import { useParams } from 'common'
import { PageContainer } from 'ui-patterns/PageContainer'
import {
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
} from 'ui-patterns/PageHeader'

import { IntegrationSettings } from '@/components/interfaces/Settings/Integrations/IntegrationsSettings'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import SettingsLayout from '@/components/layouts/ProjectSettingsLayout/SettingsLayout'
import { UnknownInterface } from '@/components/ui/UnknownInterface'
import { STUDIO_CAPABILITIES } from '@/lib/constants/deployment-profile'
import { t as $t } from '@/lib/i18n'
import type { NextPageWithLayout } from '@/types'

const ProjectSettingsIntegrations: NextPageWithLayout = () => {
  const { ref } = useParams()

  if (!STUDIO_CAPABILITIES.hostedMarketplaceIntegrations) {
    return <UnknownInterface urlBack={`/project/${ref}/settings/general`} />
  }

  return (
    <>
      <PageHeader size="small">
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>{$t('Integrations')}</PageHeaderTitle>
            <PageHeaderDescription>
              {$t('Connect external services to your project')}
            </PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer size="small">
        <IntegrationSettings />
      </PageContainer>
    </>
  )
}

ProjectSettingsIntegrations.getLayout = (page) => (
  <DefaultLayout>
    <SettingsLayout title={$t('Integrations')}>{page}</SettingsLayout>
  </DefaultLayout>
)
export default ProjectSettingsIntegrations
