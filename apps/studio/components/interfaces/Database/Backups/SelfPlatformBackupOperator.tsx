import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import { useRouter } from 'next/router'
import { useEffect, useState } from 'react'
import { Badge, Button, Card, CardContent, CardFooter, Input, Progress } from 'ui'
import { Admonition } from 'ui-patterns/Admonition'
import { GenericSkeletonLoader } from 'ui-patterns/ShimmeringLoader'

import { BackupManagementUnavailable } from './BackupManagementUnavailable'
import { BackupOperatorNotConfigured } from './BackupOperatorNotConfigured'
import {
  canExecuteRestore,
  canRollbackRestore,
  getAAL2UpgradePath,
  isRestorePlanExpired,
} from './SelfPlatformBackupOperator.utils'
import { SelfPlatformBackupOperatorPolicy } from './SelfPlatformBackupOperatorPolicy'
import { SelfPlatformBackupOperatorStatus } from './SelfPlatformBackupOperatorStatus'
import { AlertError } from '@/components/ui/AlertError'
import { isActiveBackupOperatorJob } from '@/data/backup-operator/backup-operator-job.utils'
import {
  isOperatorAAL2RequiredError,
  isOperatorRestorePlanInvalidError,
  useJobResolutionMutation,
  useRestoreExecuteMutation,
  useRestorePlanCreateMutation,
  useRestoreRollbackMutation,
} from '@/data/backup-operator/backup-operator-mutations'
import {
  backupPolicyQueryOptions,
  operatorBackupsQueryOptions,
  operatorJobQueryOptions,
  restorePlanQueryOptions,
} from '@/data/backup-operator/backup-operator-query'
import { useBackupOperatorEvents } from '@/data/backup-operator/use-backup-operator-events'
import { backupOperatorStatusQueryOptions } from '@/data/database/backup-operator-status-query'
import { useMfaListFactorsQuery } from '@/data/profile/mfa-list-factors-query'
import { t as $t } from '@/lib/i18n'

interface SelfPlatformBackupOperatorProps {
  projectRef?: string
}

export function SelfPlatformBackupOperator({ projectRef }: SelfPlatformBackupOperatorProps) {
  const statusQuery = useQuery(backupOperatorStatusQueryOptions({ projectRef }))

  if (statusQuery.isPending) return <GenericSkeletonLoader />
  if (statusQuery.isError) {
    return (
      <AlertError error={statusQuery.error} subject={$t('Failed to check Backup management')} />
    )
  }
  if (statusQuery.data.management && statusQuery.data.management.state !== 'available') {
    return (
      <BackupManagementUnavailable
        availability={statusQuery.data.management}
        projectRef={projectRef}
      />
    )
  }
  if (!statusQuery.data.configured) {
    return <BackupOperatorNotConfigured projectRef={projectRef} status={statusQuery.data} />
  }

  return <SelfPlatformBackupOperatorControls projectRef={projectRef} />
}

function SelfPlatformBackupOperatorControls({ projectRef }: SelfPlatformBackupOperatorProps) {
  const router = useRouter()
  const [recoveryTarget, setRecoveryTarget] = useState('')
  const [confirmationHash, setConfirmationHash] = useState('')
  const [requiresAAL2, setRequiresAAL2] = useState(false)
  const [requiresNewPlan, setRequiresNewPlan] = useState(false)
  const [, setPlanExpiryCheck] = useState(0)
  const [selectedPlanId, setSelectedPlanId] = useState<string>()
  const [selectedJobId, setSelectedJobId] = useState<string>()
  const planId =
    typeof router.query.backupPlan === 'string' ? router.query.backupPlan : selectedPlanId
  const jobId = typeof router.query.backupJob === 'string' ? router.query.backupJob : selectedJobId
  const policyQuery = useQuery(backupPolicyQueryOptions({ projectRef }))
  const backupsQuery = useQuery(operatorBackupsQueryOptions({ projectRef }))
  const jobQuery = useQuery(operatorJobQueryOptions({ projectRef, jobId }))
  const planQuery = useQuery(restorePlanQueryOptions({ projectRef, planId }))
  const { events, error: eventsError } = useBackupOperatorEvents({
    projectRef,
    jobId,
    jobState: jobQuery.data?.state,
  })
  const planMutation = useRestorePlanCreateMutation({
    onSuccess: (plan) => updateSelection({ backupPlan: plan.id, backupJob: undefined }),
  })
  const executeMutation = useRestoreExecuteMutation({
    onSuccess: (job) => updateSelection({ backupPlan: planId, backupJob: job.id }),
    onError: (error) => {
      setRequiresAAL2(isOperatorAAL2RequiredError(error))
      setRequiresNewPlan(isOperatorRestorePlanInvalidError(error))
    },
  })
  const rollbackMutation = useRestoreRollbackMutation()
  const resolutionMutation = useJobResolutionMutation()
  const factorsQuery = useMfaListFactorsQuery({ enabled: requiresAAL2 })
  const hasMfaFactor = (factorsQuery.data?.totp.length ?? 0) > 0

  useEffect(() => {
    if (planQuery.data === undefined) return
    const expiresIn = new Date(planQuery.data.expiresAt).getTime() - Date.now()
    if (expiresIn <= 0) return
    const timer = window.setTimeout(
      () => setPlanExpiryCheck((value) => value + 1),
      Math.min(expiresIn + 50, 2_147_483_647)
    )
    return () => window.clearTimeout(timer)
  }, [planQuery.data])

  const updateSelection = ({
    backupPlan,
    backupJob,
  }: {
    backupPlan?: string
    backupJob?: string
  }) => {
    setSelectedPlanId(backupPlan)
    setSelectedJobId(backupJob)
    void router.replace(
      { pathname: router.pathname, query: { ...router.query, backupPlan, backupJob } },
      undefined,
      { shallow: true }
    )
  }

  if (policyQuery.isPending || backupsQuery.isPending) return <GenericSkeletonLoader />
  if (policyQuery.isError) {
    return <AlertError error={policyQuery.error} subject={$t('Failed to load the backup policy')} />
  }
  if (backupsQuery.isError) {
    return <AlertError error={backupsQuery.error} subject={$t('Failed to load operator backups')} />
  }

  const policy = policyQuery.data
  const backupState = backupsQuery.data
  const restorePlan = planQuery.data ?? null
  const isPlanExpired = isRestorePlanExpired(restorePlan, new Date())
  const mustRegeneratePlan = isPlanExpired || requiresNewPlan
  const canExecute = canExecuteRestore(restorePlan, confirmationHash, new Date())
  const canRollback = canRollbackRestore(jobQuery.data, new Date())
  const isJobStale =
    jobQuery.data !== undefined &&
    isActiveBackupOperatorJob(jobQuery.data.state) &&
    Date.now() - new Date(jobQuery.data.updatedAt).getTime() > 60_000

  const createRestorePlan = (target: string) => {
    if (!projectRef || !target) return
    setConfirmationHash('')
    setRequiresAAL2(false)
    setRequiresNewPlan(false)
    executeMutation.reset()
    planMutation.mutate({ projectRef, recoveryTarget: new Date(target).toISOString() })
  }

  const handleCreatePlan = () => createRestorePlan(recoveryTarget)

  const handleRegeneratePlan = () => {
    if (!restorePlan) return
    createRestorePlan(restorePlan.recoveryTarget)
  }

  const handleExecute = () => {
    if (!projectRef || !restorePlan || !canExecute) return
    executeMutation.mutate({ projectRef, planId: restorePlan.id, planHash: confirmationHash })
  }

  const handleRollback = () => {
    if (!projectRef || !jobId || !canRollback) return
    rollbackMutation.mutate({ projectRef, jobId })
  }

  const handleUpgradeAAL2 = () => {
    void router.push({
      pathname: getAAL2UpgradePath(hasMfaFactor),
      query: {
        returnTo: router.asPath,
        ...(hasMfaFactor ? { reauthenticate: 'true' } : {}),
      },
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <SelfPlatformBackupOperatorStatus projectRef={projectRef} />
      {backupState.isStale && (
        <Admonition
          type="warning"
          title={$t('Backup observations are stale')}
          description={$t(
            'The Operator has not published a recent repository observation. Restore planning remains blocked until fresh evidence is available.'
          )}
        />
      )}
      {backupState.blockers.length > 0 && (
        <Admonition
          type="warning"
          title={$t('Backup operations are blocked')}
          description={backupState.blockers.map((blocker) => $t(blocker)).join(' ')}
        />
      )}

      <SelfPlatformBackupOperatorPolicy
        projectRef={projectRef}
        policy={policy}
        isObservationStale={backupState.isStale}
        onJobSelected={(selectedJobId) =>
          updateSelection({ backupPlan: planId, backupJob: selectedJobId })
        }
      />
      {requiresAAL2 && (
        <Admonition
          type="warning"
          title={$t('Additional authentication required')}
          description={$t(
            hasMfaFactor
              ? 'Verify MFA again to refresh AAL2, then return and confirm the unchanged restore plan.'
              : 'Enable MFA on your account first'
          )}
        >
          <Button type="button" loading={factorsQuery.isPending} onClick={handleUpgradeAAL2}>
            {$t(hasMfaFactor ? 'Verify AAL2 again' : 'Set up MFA')}
          </Button>
        </Admonition>
      )}

      <Card>
        <CardContent className="py-4">
          <p className="text-sm font-medium">{$t('Available physical backups')}</p>
          <p className="text-sm text-foreground-light">
            {$t('Recovery confidence:')} {$t(backupState.confidence)}
          </p>
          {backupState.backups.length === 0 ? (
            <p className="mt-4 text-sm text-foreground-light">
              {$t(
                'No backups have been observed yet. The first full backup must complete before restore.'
              )}
            </p>
          ) : (
            <ul className="mt-4 divide-y">
              {backupState.backups.map((backup) => (
                <li className="flex items-center justify-between py-2 text-sm" key={backup.id}>
                  <span>{new Date(backup.startedAt).toLocaleString()}</span>
                  <span className="text-foreground-light">
                    {$t(backup.type)} · {$t(backup.status)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="flex items-center justify-between gap-4 py-4">
          <div>
            <p className="text-sm font-medium">{$t('Isolated restore drill')}</p>
            {backupState.drill === null ? (
              <p className="text-sm text-foreground-light">
                {$t('No isolated restore drill evidence has been published yet.')}
              </p>
            ) : (
              <p className="text-sm text-foreground-light">
                {$t('Last completed')} {new Date(backupState.drill.completedAt).toLocaleString()}{' '}
                {$t('· target')} {new Date(backupState.drill.targetTime).toLocaleString()}
              </p>
            )}
          </div>
          <Badge variant={backupState.drill?.passed ? 'success' : 'warning'}>
            {backupState.drill?.passed ? $t('Verified') : $t('Not verified')}
          </Badge>
        </CardContent>
        {backupState.drill?.evidenceDigest && (
          <CardFooter>
            <p className="break-all font-mono text-xs text-foreground-light">
              {backupState.drill.evidenceDigest}
            </p>
          </CardFooter>
        )}
      </Card>

      <Card>
        <CardContent className="flex flex-col gap-4 py-4">
          <div>
            <p className="text-sm font-medium">{$t('Point-in-time restore')}</p>
            <p className="text-sm text-foreground-light">
              {$t(
                'Restore is destructive and requires a recent AAL2 session plus confirmation of the exact plan hash.'
              )}
            </p>
          </div>
          <Input
            type="datetime-local"
            aria-label={$t('Recovery target')}
            value={recoveryTarget}
            onChange={(event) => setRecoveryTarget(event.target.value)}
          />
          <Button
            type="button"
            loading={planMutation.isPending}
            disabled={!recoveryTarget || backupState.isStale || backupState.blockers.length > 0}
            onClick={handleCreatePlan}
          >
            {$t('Preview restore impact')}
          </Button>

          {restorePlan && (
            <div className="flex flex-col gap-3 rounded-md border p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <AlertTriangle size={16} /> {$t('Confirm destructive restore')}
              </div>
              <p className="text-sm text-foreground-light">
                {$t(restorePlan.impact.serviceInterruption)} {$t('Affected nodes:')}{' '}
                {restorePlan.impact.affectedNodes.join(', ')}.
              </p>
              {restorePlan.blockers.length > 0 && (
                <Admonition
                  type="warning"
                  title={$t('Restore plan is blocked')}
                  description={restorePlan.blockers.map((blocker) => $t(blocker)).join(' ')}
                />
              )}
              {mustRegeneratePlan && (
                <Admonition
                  type="warning"
                  title={$t(
                    isPlanExpired ? 'Restore plan expired' : 'Restore plan must be renewed'
                  )}
                  description={$t(
                    isPlanExpired
                      ? 'Preview the restore impact again to create a new plan before confirming the restore.'
                      : 'The previous confirmation cannot be continued safely. Regenerate the plan from fresh evidence before trying again.'
                  )}
                >
                  <Button
                    type="button"
                    loading={planMutation.isPending}
                    onClick={handleRegeneratePlan}
                  >
                    {$t('Regenerate restore plan')}
                  </Button>
                </Admonition>
              )}
              {executeMutation.isError && !requiresAAL2 && !requiresNewPlan && (
                <AlertError error={executeMutation.error} subject={$t('Failed to start restore')} />
              )}
              {!mustRegeneratePlan && (
                <>
                  <p className="break-all font-mono text-xs">{restorePlan.hash}</p>
                  <Input
                    aria-label={$t('Exact restore plan hash')}
                    placeholder={$t('Paste the exact plan hash')}
                    value={confirmationHash}
                    onChange={(event) => setConfirmationHash(event.target.value)}
                  />
                  <Button
                    type="button"
                    variant="danger"
                    loading={executeMutation.isPending}
                    disabled={!canExecute || requiresAAL2}
                    onClick={handleExecute}
                  >
                    {$t('Confirm and execute restore')}
                  </Button>
                </>
              )}
            </div>
          )}

          {jobQuery.isPending && jobId && <GenericSkeletonLoader />}
          {jobId && jobQuery.isError && (
            <AlertError error={jobQuery.error} subject={$t('Failed to load restore progress')} />
          )}
          {jobQuery.data && (
            <div className="flex flex-col gap-3 rounded-md border p-4">
              <div className="flex items-center justify-between text-sm">
                <span>
                  {$t(jobQuery.data.type === 'restore' ? 'Restore job' : 'Backup job')}{' '}
                  {jobQuery.data.id}
                </span>
                <Badge>{$t(jobQuery.data.state)}</Badge>
              </div>
              <Progress value={jobQuery.data.progress} />
              <p className="text-xs text-foreground-light">
                {$t('{{count}} retained events received', { count: events.length })}
              </p>
              {jobQuery.data.evidence && (
                <div className="flex flex-col gap-1">
                  <p className="text-xs font-medium">{$t('Execution evidence')}</p>
                  <pre className="max-h-48 overflow-auto rounded-md bg-surface-200 p-3 text-xs">
                    {JSON.stringify(jobQuery.data.evidence, null, 2)}
                  </pre>
                </div>
              )}
              {eventsError && (
                <p className="text-sm text-warning">{$t('Job event stream is reconnecting.')}</p>
              )}
              {isJobStale && (
                <p className="text-sm text-warning">
                  {$t('Progress is stale. Verify the Operator connection.')}
                </p>
              )}
              {jobQuery.data.manualIntervention && (
                <Admonition
                  type="warning"
                  title={$t(jobQuery.data.manualIntervention.summary)}
                  description={$t(jobQuery.data.manualIntervention.safeAction)}
                />
              )}
              {(jobQuery.data.state === 'failed' ||
                jobQuery.data.state === 'orphaned' ||
                jobQuery.data.state === 'manual-intervention') &&
                projectRef &&
                jobId && (
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      loading={resolutionMutation.isPending}
                      onClick={() =>
                        resolutionMutation.mutate({ projectRef, jobId, action: 'retry' })
                      }
                    >
                      {$t('Retry safely')}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      loading={resolutionMutation.isPending}
                      onClick={() =>
                        resolutionMutation.mutate({ projectRef, jobId, action: 'cancel' })
                      }
                    >
                      {$t('Cancel job')}
                    </Button>
                  </div>
                )}
              {jobQuery.data.rollbackUntil && (
                <Button
                  type="button"
                  icon={<RotateCcw />}
                  loading={rollbackMutation.isPending}
                  disabled={!canRollback}
                  onClick={handleRollback}
                >
                  {$t('Roll back restore')}
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
