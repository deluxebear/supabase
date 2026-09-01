import type { PropsWithChildren } from 'react'
import { Admonition } from 'ui-patterns/Admonition'
import { PageContainer } from 'ui-patterns/PageContainer'
import {
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
} from 'ui-patterns/PageHeader'
import { PageSection, PageSectionContent } from 'ui-patterns/PageSection'

import { DefaultEdgeFunctionSecrets } from '@/components/interfaces/Functions/EdgeFunctionSecrets/DefaultEdgeFunctionSecrets'
import { DEFAULT_EDGE_FUNCTION_SECRETS } from '@/components/interfaces/Functions/EdgeFunctionSecrets/DefaultEdgeFunctionSecrets.utils'
import { EdgeFunctionSecrets } from '@/components/interfaces/Functions/EdgeFunctionSecrets/EdgeFunctionSecrets'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import { WorkersLayout } from '@/components/layouts/WorkersLayout/WorkersLayout'
import { DocsButton } from '@/components/ui/DocsButton'
import { useDeploymentMode } from '@/hooks/misc/useDeploymentMode'
import { DOCS_URL, IS_PLATFORM } from '@/lib/constants'
import { t as $t } from '@/lib/i18n'
import type { NextPageWithLayout } from '@/types'

const WorkerSecretsPage: NextPageWithLayout = () => {
  const { isCli, isSelfHosted } = useDeploymentMode()

  if (!IS_PLATFORM) {
    return (
      <PageContainer size="large">
        <PageSection>
          <PageSectionContent className="space-y-4 md:space-y-8">
            {isCli && (
              <Admonition
                type="default"
                title={$t('Local development with the Supabase CLI')}
                description={<p>{$t('Add custom secrets from the Supabase CLI.')}</p>}
              />
            )}
            {isSelfHosted && (
              <Admonition
                type="default"
                title={$t('Self-hosted Supabase')}
                description={<p>{$t('Set custom secrets via environment variables.')}</p>}
              />
            )}
            <section className="space-y-4">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
                <div className="space-y-1">
                  <h3 className="text-foreground text-base">{$t('Default secrets')}</h3>
                  <p className="text-sm text-foreground-light">
                    {$t('Reserved secrets available in every project')}
                  </p>
                </div>
                <DocsButton href={`${DOCS_URL}/guides/functions/secrets#default-secrets`} />
              </div>
              <DefaultEdgeFunctionSecrets
                secrets={DEFAULT_EDGE_FUNCTION_SECRETS.filter((secret) => !secret.isRuntime)}
              />
            </section>
          </PageSectionContent>
        </PageSection>
      </PageContainer>
    )
  }

  return (
    <PageContainer size="large">
      <PageSection>
        <PageSectionContent className="space-y-4 md:space-y-8">
          <Admonition
            type="default"
            title={$t('Secrets are shared between Edge Functions and Workers')}
          />
          <EdgeFunctionSecrets />
        </PageSectionContent>
      </PageSection>
    </PageContainer>
  )
}

// Hoisted out of `getLayout` so the TanStack route can import it directly.
export const WorkerSecretsPageWrapper = ({ children }: PropsWithChildren) => (
  <div className="w-full min-h-full flex flex-col items-stretch">
    <PageHeader size="large">
      <PageHeaderMeta>
        <PageHeaderSummary>
          <PageHeaderTitle>{$t('Secrets')}</PageHeaderTitle>
          <PageHeaderDescription>
            {$t('Environment variables loaded into every worker at start-up')}
          </PageHeaderDescription>
        </PageHeaderSummary>
      </PageHeaderMeta>
    </PageHeader>

    {children}
  </div>
)

WorkerSecretsPage.getLayout = (page) => (
  <DefaultLayout>
    <WorkersLayout title={$t('Secrets')}>
      <WorkerSecretsPageWrapper>{page}</WorkerSecretsPageWrapper>
    </WorkersLayout>
  </DefaultLayout>
)

export default WorkerSecretsPage
