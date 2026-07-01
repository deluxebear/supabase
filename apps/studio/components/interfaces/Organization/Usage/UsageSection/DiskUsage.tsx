import MotionNumber from '@number-flow/react'
import Link from 'next/link'
import { useMemo } from 'react'
import { Alert, AlertDescription, AlertTitle, Button, CriticalIcon } from 'ui'
import { InfoTooltip } from 'ui-patterns/info-tooltip'
import { ShimmeringLoader } from 'ui-patterns/ShimmeringLoader'

import { SectionContent } from '../SectionContent'
import { CategoryAttribute } from '../Usage.constants'
import { AlertError } from '@/components/ui/AlertError'
import Panel from '@/components/ui/Panel'
import { PricingMetric } from '@/data/analytics/org-daily-stats-query'
import { useOrgProjectsInfiniteQuery } from '@/data/projects/org-projects-infinite-query'
import type { OrgSubscription } from '@/data/subscriptions/types'
import { OrgUsageResponse } from '@/data/usage/org-usage-query'
import { PROJECT_STATUS } from '@/lib/constants'
import { t as $t } from '@/lib/i18n'

export interface DiskUsageProps {
  slug: string
  projectRef?: string | null
  attribute: CategoryAttribute
  subscription?: OrgSubscription
  usage?: OrgUsageResponse

  currentBillingCycleSelected: boolean
}

export const DiskUsage = ({
  slug,
  projectRef,
  attribute,
  subscription,
  usage,
  currentBillingCycleSelected,
}: DiskUsageProps) => {
  const {
    data,
    isError,
    isPending: isLoading,
    isSuccess,
    error,
  } = useOrgProjectsInfiniteQuery({ slug }, { enabled: currentBillingCycleSelected })
  const projects = useMemo(() => data?.pages.flatMap((page) => page.projects) || [], [data?.pages])

  const relevantProjects = useMemo(() => {
    return isSuccess
      ? projects
          .filter((project) => {
            // We do want to show branches that are exceeding the 8 GB limit, as people could have persistent or very long-living branches
            const isBranchExceedingFreeQuota =
              project.is_branch && project.databases.some((db) => (db.disk_volume_size_gb ?? 8) > 8)

            const isActiveProject = project.status !== PROJECT_STATUS.INACTIVE

            const isHostedOnAws = project.databases.every((db) => db.cloud_provider === 'AWS')

            return (
              (!project.is_branch || isBranchExceedingFreeQuota) && isActiveProject && isHostedOnAws
            )
          })
          .filter((it) => it.ref === projectRef || !projectRef)
      : []
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSuccess, projects, projectRef])

  const hasProjectsExceedingDiskSize = useMemo(() => {
    return relevantProjects.some((it) =>
      it.databases.some(
        (db) => db.type === 'READ_REPLICA' || (db.disk_volume_size_gb && db.disk_volume_size_gb > 8)
      )
    )
  }, [relevantProjects])

  const gp3UsageInPeriod = usage?.usages.find(
    (it) => it.metric === PricingMetric.DISK_SIZE_GB_HOURS_GP3
  )
  const io2UsageInPeriod = usage?.usages.find(
    (it) => it.metric === PricingMetric.DISK_SIZE_GB_HOURS_IO2
  )

  return (
    <div id={attribute.anchor} className="scroll-my-12">
      <SectionContent section={attribute}>
        {isLoading && (
          <div className="space-y-2">
            <ShimmeringLoader />
            <ShimmeringLoader className="w-3/4" />
            <ShimmeringLoader className="w-1/2" />
          </div>
        )}
        {isError && <AlertError subject="Failed to retrieve usage data" error={error} />}
        {isSuccess && (
          <div className="space-y-4">
            {currentBillingCycleSelected &&
              subscription?.usage_billing_enabled === false &&
              hasProjectsExceedingDiskSize && (
                <Alert variant="warning">
                  <CriticalIcon />
                  <AlertTitle>{$t('Projects exceeding quota')}</AlertTitle>
                  <AlertDescription>
                    {$t(
                      'You have projects that are exceeding 8 GB of provisioned disk size, but do not allow any overages with the Spend Cap on. Reduce the disk size or disable the spend cap.'
                    )}
                  </AlertDescription>
                </Alert>
              )}

            <div>
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-4">
                  <p className="text-sm">{attribute.name} usage</p>
                </div>
              </div>

              <div className="flex items-center justify-between border-b py-1">
                <p className="text-xs text-foreground-light">
                  {$t('Included in')} {subscription?.plan?.name} {$t('Plan')}
                </p>
                <p className="text-xs">{$t('8 GB GP3 disk per project')}</p>
              </div>

              <div className="flex items-center justify-between">
                <p className="text-xs text-foreground-light">{$t('Overages in period')}</p>
                <p className="text-xs">
                  {(gp3UsageInPeriod?.usage ?? 0).toLocaleString()} {$t('GP3 GB-Hrs')}
                  {io2UsageInPeriod?.usage
                    ? ` / ${io2UsageInPeriod.usage.toLocaleString()} IO2 GB-Hrs`
                    : ``}
                </p>
              </div>
            </div>

            {currentBillingCycleSelected ? (
              <div className="space-y-4">
                <div className="space-y-1">
                  <p className="text-sm">{$t('Current disk size per project')}</p>
                  <p className="text-sm text-foreground-light">
                    {$t(
                      "Breakdown of disk per project. Head to your project's disk management section to see database size used."
                    )}
                  </p>
                </div>

                {relevantProjects.length === 0 && (
                  <Panel>
                    <Panel.Content>
                      <div className="flex flex-col items-center justify-center">
                        <p className="text-sm">{$t('No active projects')}</p>
                        <p className="text-sm text-foreground-light">
                          {$t("You don't have any active projects in this organization.")}
                        </p>
                      </div>
                    </Panel.Content>
                  </Panel>
                )}

                {relevantProjects.map((project, idx) => {
                  const primaryDiskUsage = project.databases
                    .filter((it) => it.type === 'PRIMARY')
                    .reduce((acc, curr) => acc + (curr.disk_volume_size_gb ?? 8), 0)
                  const replicaDbs = project.databases.filter((it) => it.type !== 'PRIMARY')
                  const replicaDiskUsage = replicaDbs.reduce(
                    (acc, curr) => acc + (curr.disk_volume_size_gb ?? 8),
                    0
                  )

                  const totalDiskUsage = primaryDiskUsage + replicaDiskUsage

                  return (
                    <div
                      key={`usage-project-${project.ref}`}
                      className={idx !== relevantProjects.length - 1 ? 'border-b pb-2' : ''}
                    >
                      <div className="flex justify-between">
                        <span className="text-foreground-light flex items-center gap-2">
                          {project.name}
                        </span>
                        <Button asChild variant="default" size={'tiny'}>
                          <Link href={`/project/${project.ref}/settings/compute-and-disk`}>
                            {$t('Manage Disk')}
                          </Link>
                        </Button>
                      </div>
                      <div className="flex flex-col gap-2">
                        <div className="flex items-center h-6 gap-3">
                          <span className="text-foreground-light text-sm font-mono flex items-center gap-2">
                            <span className="text-foreground font-semibold mt-[-2px]">
                              <MotionNumber
                                value={totalDiskUsage}
                                style={{ lineHeight: 0.8 }}
                                className="font-mono"
                              />
                            </span>{' '}
                            {$t('GB Disk provisioned')}
                          </span>
                          <InfoTooltip side="top">
                            <p>
                              {primaryDiskUsage} {$t('GB for Primary Database')}
                            </p>
                            {replicaDbs.length > 0 && (
                              <>
                                <p>
                                  {replicaDiskUsage} {$t('GB for')} {replicaDbs.length} {$t('Read')}{' '}
                                  {replicaDbs.length === 1 ? 'Replica' : 'Replicas'}
                                </p>
                                <p className="mt-1">
                                  {$t(
                                    'Read replicas have their own disk and use 25% more disk to account for WAL files.'
                                  )}
                                </p>
                              </>
                            )}
                          </InfoTooltip>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <Panel>
                <Panel.Content>
                  <div className="flex flex-col items-center justify-center">
                    <p className="text-sm">{$t('Data not available')}</p>
                    <p className="text-sm text-foreground-light">
                      {$t('Switch to current billing cycle to see current disk size per project.')}
                    </p>
                  </div>
                </Panel.Content>
              </Panel>
            )}
          </div>
        )}
      </SectionContent>
    </div>
  )
}
