import { useParams } from 'common'
import { formatRelative } from 'date-fns'
import { BadgeCheck, RefreshCwIcon } from 'lucide-react'
import Link from 'next/link'
import { Button, Card, CardContent, CardHeader, CardTitle } from 'ui'
import { Admonition } from 'ui-patterns/admonition'
import {
  PageSection,
  PageSectionContent,
  PageSectionDescription,
  PageSectionMeta,
  PageSectionSummary,
  PageSectionTitle,
} from 'ui-patterns/PageSection'
import { ShimmeringLoader } from 'ui-patterns/ShimmeringLoader'
import { TimestampInfo } from 'ui-patterns/TimestampInfo'

import { isInstalled, isSyncRunning, isUninstalling } from './stripe-sync-status'
import { ConstrainedIntegrationTabScaffold } from '@/components/interfaces/Integrations/ConstrainedIntegrationTabScaffold'
import { useStripeSyncStatus } from '@/components/interfaces/Integrations/templates/StripeSyncEngine/useStripeSyncStatus'
import { t as $t } from '@/lib/i18n'

export const StripeSyncSettingsPage = () => {
  const { ref } = useParams()

  const {
    schemaComment: { status: installationStatus },
    syncState,
  } = useStripeSyncStatus()
  const installed = isInstalled(installationStatus)
  const isSyncing = isSyncRunning(syncState)
  const uninstalling = isUninstalling(installationStatus)

  if (!installed || uninstalling) {
    return (
      <ConstrainedIntegrationTabScaffold>
        <PageSection>
          <Admonition type="default" description={$t('Stripe Sync Engine is not installed.')} />
        </PageSection>
      </ConstrainedIntegrationTabScaffold>
    )
  }

  return (
    <ConstrainedIntegrationTabScaffold>
      <PageSection className="py-0!">
        <PageSectionMeta>
          <PageSectionSummary>
            <PageSectionTitle>{$t('Manage Stripe data')}</PageSectionTitle>
            <PageSectionDescription>
              {$t('Access and manage the synced Stripe data in your database.')}
            </PageSectionDescription>
          </PageSectionSummary>
        </PageSectionMeta>
        <PageSectionContent>
          <Card>
            <CardHeader>
              <CardTitle className="text-foreground-lighter">
                {!syncState ? (
                  <ShimmeringLoader className="py-2" />
                ) : (
                  <div className="flex items-center justify-between gap-2">
                    {isSyncing ? (
                      <>
                        <div className="flex items-center gap-x-3 text-foreground-light">
                          <RefreshCwIcon size={14} className="animate-spin" />
                          <p>{$t('Sync in progress')}</p>
                        </div>
                        {syncState.started_at && (
                          <p className="text-foreground-light">
                            {$t('Started')}{' '}
                            <TimestampInfo
                              utcTimestamp={syncState.started_at}
                              label={
                                syncState.started_at
                                  ? formatRelative(new Date(syncState.started_at), new Date())
                                  : 'recently'
                              }
                            />
                          </p>
                        )}
                      </>
                    ) : (
                      <>
                        <div className="flex items-center gap-x-3 text-foreground-light">
                          <BadgeCheck size={14} />
                          <p>{$t('All up to date')}</p>
                        </div>
                        {syncState.closed_at && (
                          <p className="text-foreground-light">
                            {$t('Last synced')}{' '}
                            <TimestampInfo
                              utcTimestamp={syncState.closed_at}
                              label={
                                syncState.closed_at
                                  ? formatRelative(new Date(syncState.closed_at), new Date())
                                  : 'recently'
                              }
                            />
                          </p>
                        )}
                      </>
                    )}
                  </div>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="@container">
              <div className="flex flex-col items-start justify-between gap-4 @md:flex-row @md:items-center">
                <div className="flex flex-col gap-1">
                  <h5 className="text-sm">{$t('View Stripe data in Table Editor')}</h5>
                  <p className="text-sm text-foreground-light text-balance">
                    {$t('The Stripe Sync Engine stores all synced data in the')}{' '}
                    <code className="text-code-inline break-keep!">stripe</code>{' '}
                    {$t('schema. You can view and query this data directly in the Table Editor.')}
                  </p>
                </div>

                <Button asChild variant="default" className="ml-8 @md:ml-0">
                  <Link href={`/project/${ref}/editor?schema=stripe`}>
                    {$t('Open Table Editor')}
                  </Link>
                </Button>
              </div>
            </CardContent>
          </Card>
        </PageSectionContent>
      </PageSection>
    </ConstrainedIntegrationTabScaffold>
  )
}
