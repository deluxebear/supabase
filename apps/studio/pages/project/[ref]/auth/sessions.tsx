import { PermissionAction } from '@supabase/shared-types/out/constants'
import { PageContainer } from 'ui-patterns/PageContainer'
import {
  PageHeader,
  PageHeaderDescription,
  PageHeaderMeta,
  PageHeaderSummary,
  PageHeaderTitle,
} from 'ui-patterns/PageHeader'
import { PageSection, PageSectionContent } from 'ui-patterns/PageSection'
import { GenericSkeletonLoader } from 'ui-patterns/ShimmeringLoader'

import { SessionsAuthSettingsForm } from '@/components/interfaces/Auth/SessionsAuthSettingsForm/SessionsAuthSettingsForm'
import AuthLayout from '@/components/layouts/AuthLayout/AuthLayout'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import { NoPermission } from '@/components/ui/NoPermission'
import { useAsyncCheckPermissions } from '@/hooks/misc/useCheckPermissions'
import { t as $t } from '@/lib/i18n'
import type { NextPageWithLayout } from '@/types'

const SessionsPage: NextPageWithLayout = () => {
  const { can: canReadAuthSettings, isSuccess: isPermissionsLoaded } = useAsyncCheckPermissions(
    PermissionAction.READ,
    'custom_config_gotrue'
  )

  if (isPermissionsLoaded && !canReadAuthSettings) {
    return <NoPermission isFullPage resourceText="access your project's authentication settings" />
  }

  return (
    <>
      <PageHeader size="default">
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>{$t('User Sessions')}</PageHeaderTitle>
            <PageHeaderDescription>
              {$t('Configure settings for user sessions and refresh tokens')}
            </PageHeaderDescription>
          </PageHeaderSummary>
        </PageHeaderMeta>
      </PageHeader>
      <PageContainer size="default">
        {!isPermissionsLoaded ? (
          <PageSection>
            <PageSectionContent>
              <GenericSkeletonLoader />
            </PageSectionContent>
          </PageSection>
        ) : (
          <SessionsAuthSettingsForm />
        )}
      </PageContainer>
    </>
  )
}

SessionsPage.getLayout = (page) => (
  <DefaultLayout>
    <AuthLayout title={$t('Sessions')}>{page}</AuthLayout>
  </DefaultLayout>
)

export default SessionsPage
