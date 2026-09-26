import { PermissionAction } from '@supabase/shared-types/out/constants'
import { useParams } from 'common'
import { DatabaseBackup, Info } from 'lucide-react'
import { Admonition } from 'ui-patterns/Admonition'
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

import { BackupsList } from '@/components/interfaces/Database/Backups/BackupsList'
import DatabaseBackupsNav from '@/components/interfaces/Database/Backups/DatabaseBackupsNav'
import { SelfPlatformBackupOperator } from '@/components/interfaces/Database/Backups/SelfPlatformBackupOperator'
import { DatabaseLayout } from '@/components/layouts/DatabaseLayout/DatabaseLayout'
import { DefaultLayout } from '@/components/layouts/DefaultLayout'
import { AlertError } from '@/components/ui/AlertError'
import { DocsButton } from '@/components/ui/DocsButton'
import { HighAvailabilityDisabledEmptyState } from '@/components/ui/HighAvailability/HighAvailabilityDisabledEmptyState'
import InformationBox from '@/components/ui/InformationBox'
import { NoPermission } from '@/components/ui/NoPermission'
import { useBackupsQuery } from '@/data/database/backups-query'
import { useAsyncCheckPermissions } from '@/hooks/misc/useCheckPermissions'
import { useIsHighAvailability, useIsOrioleDbInAws } from '@/hooks/misc/useSelectedProject'
import { DOCS_URL } from '@/lib/constants'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'
import { t as $t } from '@/lib/i18n'
import type { NextPageWithLayout } from '@/types'

const DatabaseScheduledBackups: NextPageWithLayout = () => {
  return (
    <>
      <PageHeader>
        <PageHeaderMeta>
          <PageHeaderSummary>
            <PageHeaderTitle>{$t('Database Backups')}</PageHeaderTitle>
          </PageHeaderSummary>
        </PageHeaderMeta>
        <PageHeaderNavigationTabs>
          <DatabaseBackupsNav active="scheduled" />
        </PageHeaderNavigationTabs>
      </PageHeader>
      <PageContainer>
        <PageSection>
          <PageSectionContent>
            <ScheduledBackups />
          </PageSectionContent>
        </PageSection>
      </PageContainer>
    </>
  )
}

const ScheduledBackups = () => {
  const { ref: projectRef } = useParams()

  const {
    data: backups,
    error,
    isPending: isLoading,
    isError,
    isSuccess,
  } = useBackupsQuery({ projectRef }, { enabled: !IS_SELF_PLATFORM })

  const isOrioleDbInAws = useIsOrioleDbInAws()
  const isHighAvailability = useIsHighAvailability()
  const isPitrEnabled = backups?.pitr_enabled

  const { can: canReadScheduledBackups, isSuccess: isPermissionsLoaded } = useAsyncCheckPermissions(
    PermissionAction.READ,
    'back_ups'
  )

  if (IS_SELF_PLATFORM) {
    return (
      <div className="flex flex-col gap-y-4">
        <Admonition
          type="default"
          title={$t('Observing operator-managed physical backups')}
          description={$t(
            'This page reflects the Backup Operator control plane. Physical backups and PITR cover the entire database instance, and destructive restores require a recent AAL2 session and exact plan confirmation.'
          )}
        />
        {isPermissionsLoaded && !canReadScheduledBackups ? (
          <NoPermission resourceText="view scheduled backups" />
        ) : (
          <SelfPlatformBackupOperator projectRef={projectRef} />
        )}
      </div>
    )
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
        <DocsButton abbrev={false} className="mt-2" href={`${DOCS_URL}`} />
      </Admonition>
    )
  }

  if (isHighAvailability) {
    return (
      <HighAvailabilityDisabledEmptyState
        icon={DatabaseBackup}
        title={$t('Scheduled backups unavailable on High Availability projects')}
        description={$t(
          "We're working to bring scheduled backups to High Availability projects. Contact support if this is blocking your work."
        )}
        className="max-w-none mx-0"
      />
    )
  }

  return (
    <div className="flex flex-col gap-y-4">
      {isLoading && <GenericSkeletonLoader />}

      {isError && <AlertError error={error} subject="Failed to retrieve scheduled backups" />}

      {isSuccess && (
        <>
          {!isPitrEnabled && (
            <p className="text-sm text-foreground-light">
              {$t(
                'Projects are backed up daily around midnight of your project’s region and can be restored at any time.'
              )}
            </p>
          )}

          {isPitrEnabled && (
            <InformationBox
              hideCollapse
              defaultVisibility
              icon={<Info strokeWidth={2} />}
              title={$t('Point-In-Time-Recovery (PITR) enabled')}
              description={
                <div>
                  {$t(
                    'Your project uses PITR and full daily backups are no longer taken. PITR lets you restore to a specific time (down to the second) within your selected PITR retention period.'
                  )}{' '}
                  <a
                    className="text-primary transition-colors hover:text-primary-hover"
                    href={`${DOCS_URL}/guides/platform/backups`}
                  >
                    {$t('Learn more')}
                  </a>
                </div>
              }
            />
          )}

          {isPermissionsLoaded && !canReadScheduledBackups ? (
            <NoPermission resourceText="view scheduled backups" />
          ) : (
            <BackupsList />
          )}
        </>
      )}
    </div>
  )
}

DatabaseScheduledBackups.getLayout = (page) => (
  <DefaultLayout>
    <DatabaseLayout title={$t('Backups')}>{page}</DatabaseLayout>
  </DefaultLayout>
)

export default DatabaseScheduledBackups
