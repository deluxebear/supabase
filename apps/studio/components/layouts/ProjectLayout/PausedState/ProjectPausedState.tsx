import { useParams } from 'common'
import dayjs from 'dayjs'
import { PauseCircle } from 'lucide-react'
import Link from 'next/link'
import { Button, Card, CardContent, CardFooter } from 'ui'
import { GenericSkeletonLoader } from 'ui-patterns/ShimmeringLoader'
import { TimestampInfo } from 'ui-patterns/TimestampInfo'

import { DownloadBackupsSection } from './DownloadBackupsSection'
import { PauseDisabledState } from './PauseDisabledState'
import { ResumeProjectButton } from '@/components/interfaces/Project/ResumeProjectButton'
import { AlertError } from '@/components/ui/AlertError'
import { UpgradePlanButton } from '@/components/ui/UpgradePlanButton'
import { useProjectPauseStatusQuery } from '@/data/projects/project-pause-status-query'
import { useSelectedOrganizationQuery } from '@/hooks/misc/useSelectedOrganization'
import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'
import { usePHFlag } from '@/hooks/ui/useFlag'
import { PROJECT_STATUS } from '@/lib/constants'
import { t as $t } from '@/lib/i18n'

export interface ProjectPausedStateProps {
  product?: string
}

export const ProjectPausedState = ({ product }: ProjectPausedStateProps) => {
  const { ref } = useParams()
  const { data: project } = useSelectedProjectQuery()
  const { data: selectedOrganization } = useSelectedOrganizationQuery()

  const enableProBenefitWording = usePHFlag('proBenefitWording')

  const {
    data: pauseStatus,
    error: pauseStatusError,
    isError,
    isSuccess: isPauseStatusSuccess,
    isPending: isLoading,
  } = useProjectPauseStatusQuery({ ref }, { enabled: project?.status === PROJECT_STATUS.INACTIVE })

  // null when there is no expiry (e.g. paid plans can always restore)
  const restoreExpiresAt =
    pauseStatus?.remaining_days_till_restore_disabled != null
      ? dayjs().utc().add(pauseStatus.remaining_days_till_restore_disabled, 'day').toISOString()
      : null

  const isFreePlan = selectedOrganization?.plan?.id === 'free'
  const isRestoreDisabled = isPauseStatusSuccess && !pauseStatus.can_restore

  return (
    <Card className="w-full max-w-160 mx-auto">
      <CardContent>
        <PauseCircle size={48} strokeWidth={1} className="text-foreground-lighter shrink-0 mb-4" />
        <div className="flex-1">
          <div>
            <h2 className="mb-4">
              {$t('Project "')}
              {project?.name}
              {$t('" is paused')}
            </h2>
            <div className="text-foreground-light max-w-4xl">
              {isLoading && <GenericSkeletonLoader className="mt-3" />}

              {isPauseStatusSuccess && !isRestoreDisabled ? (
                isFreePlan ? (
                  <ul className="text-sm list-disc pl-4 space-y-2">
                    <li>{$t('All data, including backups and storage objects, remains safe.')}</li>
                    {restoreExpiresAt ? (
                      <>
                        <li>
                          {$t('You can resume this project from the dashboard until')}{' '}
                          <TimestampInfo
                            displayAs="local"
                            utcTimestamp={restoreExpiresAt}
                            className="text-sm text-foreground"
                            labelFormat="DD MMM YYYY"
                          />
                          .
                        </li>
                        <li>
                          {$t(
                            'After that, this project will not be resumable, but data will still be available for download.'
                          )}
                        </li>
                      </>
                    ) : (
                      <li>{$t('You can resume this project from the dashboard.')}</li>
                    )}
                    <li>
                      {enableProBenefitWording === 'variant-a'
                        ? 'Upgrade to Pro to prevent pauses and unlock features like branching, compute upgrades, and daily backups.'
                        : 'To prevent future pauses, consider upgrading to Pro.'}
                    </li>
                  </ul>
                ) : (
                  <>
                    <p className="text-sm">
                      {$t('Your project data is safe')}
                      {restoreExpiresAt ? (
                        <>
                          {' '}
                          {$t('and available until')}{' '}
                          <TimestampInfo
                            displayAs="local"
                            utcTimestamp={restoreExpiresAt}
                            className="text-sm text-foreground"
                            labelFormat="DD MMM YYYY"
                          />
                        </>
                      ) : null}

                      {$t(', but inaccessible while paused.')}
                    </p>
                    <p className="text-sm mt-2">
                      {$t('Once resumed, usage will be billed by compute size and hours active.')}
                    </p>
                  </>
                )
              ) : !isLoading ? (
                <p className="text-sm">
                  {$t(
                    "All of your project's data is still intact, but your project is inaccessible while paused."
                  )}{' '}
                  {product !== undefined ? (
                    <>
                      {$t('Resume this project to access the')}{' '}
                      <span className="text-primary">{product}</span> page.
                    </>
                  ) : !isRestoreDisabled ? (
                    'Resume this project and get back to building!'
                  ) : null}
                </p>
              ) : null}
            </div>
          </div>
        </div>
      </CardContent>

      {isError && (
        <AlertError
          className="rounded-none border-0"
          error={pauseStatusError}
          subject="Failed to retrieve pause status"
        />
      )}

      {isPauseStatusSuccess && !isRestoreDisabled && (
        <>
          <CardFooter className="flex flex-wrap justify-end items-center gap-2">
            <ResumeProjectButton size="tiny" variant="default" />

            {isFreePlan ? (
              <UpgradePlanButton source="projectPausedStateRestore" />
            ) : (
              <Button asChild>
                <Link href={`/project/${ref}/settings/general`}>{$t('View project settings')}</Link>
              </Button>
            )}
          </CardFooter>
          <DownloadBackupsSection />
        </>
      )}

      {isPauseStatusSuccess && isRestoreDisabled && <PauseDisabledState />}
    </Card>
  )
}
