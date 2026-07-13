import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import { useRouter } from 'next/router'
import { useState } from 'react'
import { Badge, Button, Card, CardContent, CardFooter, Input, Progress } from 'ui'
import { Admonition } from 'ui-patterns/admonition'
import { GenericSkeletonLoader } from 'ui-patterns/ShimmeringLoader'

import { canExecuteRestore, canRollbackRestore } from './SelfPlatformBackupOperator.utils'
import { SelfPlatformBackupOperatorPolicy } from './SelfPlatformBackupOperatorPolicy'
import { SelfPlatformBackupOperatorStatus } from './SelfPlatformBackupOperatorStatus'
import { AlertError } from '@/components/ui/AlertError'
import {
  OperatorMutationError,
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

interface SelfPlatformBackupOperatorProps {
  projectRef?: string
}

export function SelfPlatformBackupOperator({ projectRef }: SelfPlatformBackupOperatorProps) {
  const router = useRouter()
  const [recoveryTarget, setRecoveryTarget] = useState('')
  const [confirmationHash, setConfirmationHash] = useState('')
  const [requiresAAL2, setRequiresAAL2] = useState(false)
  const [selectedPlanId, setSelectedPlanId] = useState<string>()
  const [selectedJobId, setSelectedJobId] = useState<string>()
  const planId =
    typeof router.query.backupPlan === 'string' ? router.query.backupPlan : selectedPlanId
  const jobId = typeof router.query.backupJob === 'string' ? router.query.backupJob : selectedJobId
  const policyQuery = useQuery(backupPolicyQueryOptions({ projectRef }))
  const backupsQuery = useQuery(operatorBackupsQueryOptions({ projectRef }))
  const jobQuery = useQuery(operatorJobQueryOptions({ projectRef, jobId }))
  const planQuery = useQuery(restorePlanQueryOptions({ projectRef, planId }))
  const { events, error: eventsError } = useBackupOperatorEvents({ projectRef, jobId })
  const planMutation = useRestorePlanCreateMutation({
    onSuccess: (plan) => updateSelection({ backupPlan: plan.id, backupJob: undefined }),
  })
  const executeMutation = useRestoreExecuteMutation({
    onSuccess: (job) => updateSelection({ backupPlan: planId, backupJob: job.id }),
    onError: (error) =>
      setRequiresAAL2(error instanceof OperatorMutationError && error.code === 'AAL2_REQUIRED'),
  })
  const rollbackMutation = useRestoreRollbackMutation()
  const resolutionMutation = useJobResolutionMutation()

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
    return <AlertError error={policyQuery.error} subject="Failed to load the backup policy" />
  }
  if (backupsQuery.isError) {
    return <AlertError error={backupsQuery.error} subject="Failed to load operator backups" />
  }

  const policy = policyQuery.data
  const backupState = backupsQuery.data
  const restorePlan = planQuery.data ?? null
  const canExecute = canExecuteRestore(restorePlan, confirmationHash)
  const canRollback = canRollbackRestore(jobQuery.data, new Date())
  const isJobStale =
    jobQuery.data !== undefined && Date.now() - new Date(jobQuery.data.updatedAt).getTime() > 60_000

  const handleCreatePlan = () => {
    if (!projectRef || !recoveryTarget) return
    setConfirmationHash('')
    planMutation.mutate({ projectRef, recoveryTarget: new Date(recoveryTarget).toISOString() })
  }

  const handleExecute = () => {
    if (!projectRef || !restorePlan || !canExecute) return
    executeMutation.mutate({ projectRef, planId: restorePlan.id, planHash: confirmationHash })
  }

  const handleRollback = () => {
    if (!projectRef || !jobId || !canRollback) return
    rollbackMutation.mutate({ projectRef, jobId })
  }

  return (
    <div className="flex flex-col gap-4">
      <SelfPlatformBackupOperatorStatus projectRef={projectRef} />
      {backupState.isStale && (
        <Admonition
          type="warning"
          title="Backup observations are stale"
          description="The Operator has not published a recent repository observation. Restore planning remains blocked until fresh evidence is available."
        />
      )}
      {backupState.blockers.length > 0 && (
        <Admonition
          type="warning"
          title="Backup operations are blocked"
          description={backupState.blockers.join(' ')}
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
          title="Additional authentication required"
          description="Upgrade this session to AAL2, then return and confirm the unchanged restore plan."
        >
          <Button type="button" onClick={() => window.location.assign('/sign-in-mfa')}>
            Upgrade to AAL2
          </Button>
        </Admonition>
      )}

      <Card>
        <CardContent className="py-4">
          <p className="text-sm font-medium">Available physical backups</p>
          <p className="text-sm text-foreground-light">
            Recovery confidence: {backupState.confidence}
          </p>
          {backupState.backups.length === 0 ? (
            <p className="mt-4 text-sm text-foreground-light">
              No backups have been observed yet. The first full backup must complete before restore.
            </p>
          ) : (
            <ul className="mt-4 divide-y">
              {backupState.backups.map((backup) => (
                <li className="flex items-center justify-between py-2 text-sm" key={backup.id}>
                  <span>{new Date(backup.startedAt).toLocaleString()}</span>
                  <span className="text-foreground-light">
                    {backup.type} · {backup.status}
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
            <p className="text-sm font-medium">Isolated restore drill</p>
            {backupState.drill === null ? (
              <p className="text-sm text-foreground-light">
                No isolated restore drill evidence has been published yet.
              </p>
            ) : (
              <p className="text-sm text-foreground-light">
                Last completed {new Date(backupState.drill.completedAt).toLocaleString()} · target{' '}
                {new Date(backupState.drill.targetTime).toLocaleString()}
              </p>
            )}
          </div>
          <Badge variant={backupState.drill?.passed ? 'success' : 'warning'}>
            {backupState.drill?.passed ? 'Verified' : 'Not verified'}
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
            <p className="text-sm font-medium">Point-in-time restore</p>
            <p className="text-sm text-foreground-light">
              Restore is destructive and requires a recent AAL2 session plus confirmation of the
              exact plan hash.
            </p>
          </div>
          <Input
            type="datetime-local"
            aria-label="Recovery target"
            value={recoveryTarget}
            onChange={(event) => setRecoveryTarget(event.target.value)}
          />
          <Button
            type="button"
            loading={planMutation.isPending}
            disabled={!recoveryTarget || backupState.isStale || backupState.blockers.length > 0}
            onClick={handleCreatePlan}
          >
            Preview restore impact
          </Button>

          {restorePlan && (
            <div className="flex flex-col gap-3 rounded-md border p-4">
              <div className="flex items-center gap-2 text-sm font-medium">
                <AlertTriangle size={16} /> Confirm destructive restore
              </div>
              <p className="text-sm text-foreground-light">
                {restorePlan.impact.serviceInterruption} Affected nodes:{' '}
                {restorePlan.impact.affectedNodes.join(', ')}.
              </p>
              {restorePlan.blockers.length > 0 && (
                <Admonition
                  type="warning"
                  title="Restore plan is blocked"
                  description={restorePlan.blockers.join(' ')}
                />
              )}
              <p className="break-all font-mono text-xs">{restorePlan.hash}</p>
              <Input
                aria-label="Exact restore plan hash"
                placeholder="Paste the exact plan hash"
                value={confirmationHash}
                onChange={(event) => setConfirmationHash(event.target.value)}
              />
              <Button
                type="button"
                variant="danger"
                loading={executeMutation.isPending}
                disabled={!canExecute}
                onClick={handleExecute}
              >
                Confirm and execute restore
              </Button>
            </div>
          )}

          {jobQuery.isPending && jobId && <GenericSkeletonLoader />}
          {jobQuery.isError && (
            <AlertError error={jobQuery.error} subject="Failed to load restore progress" />
          )}
          {jobQuery.data && (
            <div className="flex flex-col gap-3 rounded-md border p-4">
              <div className="flex items-center justify-between text-sm">
                <span>
                  {jobQuery.data.type === 'restore' ? 'Restore' : 'Backup'} job {jobQuery.data.id}
                </span>
                <Badge>{jobQuery.data.state}</Badge>
              </div>
              <Progress value={jobQuery.data.progress} />
              <p className="text-xs text-foreground-light">
                {events.length} retained event{events.length === 1 ? '' : 's'} received
              </p>
              {eventsError && (
                <p className="text-sm text-warning">Job event stream is reconnecting.</p>
              )}
              {isJobStale && (
                <p className="text-sm text-warning">
                  Progress is stale. Verify the Operator connection.
                </p>
              )}
              {jobQuery.data.manualIntervention && (
                <Admonition
                  type="warning"
                  title={jobQuery.data.manualIntervention.summary}
                  description={jobQuery.data.manualIntervention.safeAction}
                />
              )}
              {(jobQuery.data.state === 'orphaned' ||
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
                      Retry safely
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      loading={resolutionMutation.isPending}
                      onClick={() =>
                        resolutionMutation.mutate({ projectRef, jobId, action: 'cancel' })
                      }
                    >
                      Cancel job
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
                  Roll back restore
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
