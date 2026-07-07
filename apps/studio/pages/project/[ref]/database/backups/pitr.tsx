import { PermissionAction } from '@supabase/shared-types/out/constants'
import { useParams } from 'common'
import { AlertCircle, DatabaseBackup } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from 'ui'
import { Admonition } from 'ui-patterns/admonition'
import { PageContainer } from 'ui-patterns/PageContainer'
import {
  PageHeader,
  PageHeaderMeta,
  PageHeaderNavigationTabs,
  PageHeaderSummary,
  PageHeaderTitle,
} from 'ui-patterns/PageHeader'
import { PageSection, PageSectionContent } from 'ui-patterns/PageSection'
import { GenericSkeletonLoader } from 'ui-patterns/ShimmeringLoader'

import DatabaseBackupsNav from '@/components/interfaces/Database/Backups/DatabaseBackupsNav'
import { PITRNotice } from '@/components/interfaces/Database/Backups/PITR/PITRNotice'
import { PITRSelection } from '@/components/interfaces/Database/Backups/PITR/PITRSelection'
import DatabaseLayout from '@/components/layouts/DatabaseLayout/DatabaseLayout'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import { AlertError } from '@/components/ui/AlertError'
import { DocsButton } from '@/components/ui/DocsButton'
import { HighAvailabilityDisabledEmptyState } from '@/components/ui/HighAvailability/HighAvailabilityDisabledEmptyState'
import { NoPermission } from '@/components/ui/NoPermission'
import { UpgradeToPro } from '@/components/ui/UpgradeToPro'
import { useBackupsQuery } from '@/data/database/backups-query'
import { useCheckEntitlements } from '@/hooks/misc/useCheckEntitlements'
import { useAsyncCheckPermissions } from '@/hooks/misc/useCheckPermissions'
import { useHighAvailability } from '@/hooks/misc/useHighAvailability'
import { useIsOrioleDbInAws, useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'
import { DOCS_URL, PROJECT_STATUS } from '@/lib/constants'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'
import { t as $t } from '@/lib/i18n'
import type { NextPageWithLayout } from '@/types'

const DatabasePhysicalBackups: NextPageWithLayout = () => {
  return (
    <>
      <PageHeader>
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>{$t('Database Backups')}</PageHeaderTitle>
          </PageHeaderSummary>
        </PageHeaderMeta>
        <PageHeaderNavigationTabs>
          <DatabaseBackupsNav active="pitr" />
        </PageHeaderNavigationTabs>
      </PageHeader>
      <PageContainer>
        <PageSection>
          <PageSectionContent>
            {IS_SELF_PLATFORM && (
              <Admonition
                type="default"
                title={$t('Observing operator-managed physical backups')}
                description={$t(
                  'This page reflects the pgBackRest state your operator publishes. Physical backups and PITR cover the entire database instance (not a single logical database). Restores run via the pgBackRest CLI runbook, not from Studio.'
                )}
              />
            )}
            <div className="space-y-8">
              <PITR />
            </div>
          </PageSectionContent>
        </PageSection>
      </PageContainer>
    </>
  )
}

DatabasePhysicalBackups.getLayout = (page) => (
  <DefaultLayout>
    <DatabaseLayout title={$t('Backups')}>{page}</DatabaseLayout>
  </DefaultLayout>
)

const PITR = () => {
  const { ref: projectRef } = useParams()
  const { data: project, isPending: isProjectPending } = useSelectedProjectQuery()
  const { isHighAvailability } = useHighAvailability()
  const { hasAccess: hasAccessToPitr, isLoading: isLoadingEntitlements } =
    useCheckEntitlements('pitr.available_variants')
  const isOrioleDbInAws = useIsOrioleDbInAws()
  const {
    data: backups,
    error,
    isPending: isLoadingBackups,
    isError,
    isSuccess,
  } = useBackupsQuery({ projectRef })

  const isLoading = isLoadingBackups || isLoadingEntitlements || isProjectPending
  const isEnabled = backups?.pitr_enabled
  const isActiveHealthy = project?.status === PROJECT_STATUS.ACTIVE_HEALTHY

  const { can: canReadPhysicalBackups, isSuccess: isPermissionsLoaded } = useAsyncCheckPermissions(
    PermissionAction.READ,
    'physical_backups'
  )

  if (isPermissionsLoaded && !canReadPhysicalBackups) {
    return <NoPermission resourceText="view PITR backups" />
  }

  if (isOrioleDbInAws) {
    return (
      <Admonition
        type="default"
        title={$t('Database backups are not available for OrioleDB')}
        description={$t(
          'OrioleDB is currently in public alpha and projects created are strictly ephemeral with no database backups'
        )}
      >
        <DocsButton abbrev={false} className="mt-2" href={DOCS_URL} />
      </Admonition>
    )
  }

  if (isLoading) {
    return <GenericSkeletonLoader />
  }

  if (isHighAvailability) {
    return (
      <HighAvailabilityDisabledEmptyState
        icon={DatabaseBackup}
        title={$t('Point-in-Time Recovery unavailable on High Availability projects')}
        description={$t(
          "We're working to bring point-in-time recovery to High Availability projects. Contact support if this is blocking your work."
        )}
        className="max-w-none mx-0"
      />
    )
  }

  return (
    <>
      {isError && <AlertError error={error} subject="Failed to retrieve PITR backups" />}
      {isSuccess && (
        <>
          {!isEnabled ? (
            <UpgradeToPro
              addon={hasAccessToPitr ? 'pitr' : undefined}
              source="pitr"
              featureProposition="enable Point-in-Time Recovery"
              primaryText={
                hasAccessToPitr
                  ? 'Point in Time Recovery is available as an add-on'
                  : 'Point in Time Recovery is a Pro Plan add-on'
              }
              secondaryText={
                !hasAccessToPitr
                  ? 'Roll back your database to a specific second. Starts at $100/month. Pro Plan already includes daily backups at no extra cost.'
                  : 'Enable the add-on to add point-in-time recovery to your project.'
              }
            />
          ) : !isActiveHealthy ? (
            <Alert>
              <AlertCircle />
              <AlertTitle>
                {$t('Point in Time Recovery is not available while project is offline')}
              </AlertTitle>
              <AlertDescription>
                {$t(
                  'Your project needs to be online to restore your database with Point in Time Recovery'
                )}
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <PITRNotice />
              <PITRSelection />
            </>
          )}
        </>
      )}
    </>
  )
}

export default DatabasePhysicalBackups
