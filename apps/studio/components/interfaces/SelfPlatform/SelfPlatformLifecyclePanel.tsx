import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from 'ui'

import { lifecycleParameters, lifecycleValueLabel } from './SelfPlatformLifecyclePanel.utils'
import { AlertError } from '@/components/ui/AlertError'
import {
  findProjectCapability,
  projectCapabilitiesQueryOptions,
} from '@/data/projects/project-capabilities-query'
import {
  useCreateLifecyclePlanMutation,
  useExecuteLifecyclePlanMutation,
} from '@/data/projects/project-lifecycle-mutations'
import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'
import {
  lifecycleActions,
  type LifecycleAction,
  type LifecycleImpactPlan,
} from '@/lib/api/self-platform/lifecycle-contract'
import { t as $t } from '@/lib/i18n'

type Action = LifecycleAction
const actionLabels: Record<Action, string> = {
  'runtime.restart': 'Restart service',
  'runtime.rollout': 'Roll out service',
  'runtime.scale': 'Scale service',
  'postgres.upgrade.plan': 'Plan PostgreSQL upgrade',
  'postgres.upgrade.execute': 'Execute PostgreSQL upgrade',
  'replica.create': 'Create replica',
  'replica.remove': 'Remove replica',
  'branch.create': 'Create branch',
  'branch.restore': 'Restore branch',
  'network.bans.read': 'Read network bans',
  'network.bans.update': 'Update network bans',
}

export const SelfPlatformLifecyclePanel = () => {
  const { data: project } = useSelectedProjectQuery()
  const capabilities = useQuery(projectCapabilitiesQueryOptions({ projectRef: project?.ref }))
  const [action, setAction] = useState<Action>('runtime.restart')
  const [value, setValue] = useState('')
  const [replicas, setReplicas] = useState(1)
  const [planned, setPlanned] = useState<{
    plan: LifecycleImpactPlan
    expectedGeneration: number
  }>()
  const [error, setError] = useState<Error>()
  const createPlan = useCreateLifecyclePlanMutation({ onSuccess: setPlanned, onError: setError })
  const execute = useExecuteLifecyclePlanMutation({
    onSuccess: () => setPlanned(undefined),
    onError: setError,
  })
  if (!project?.ref) return null
  if (capabilities.isPending)
    return (
      <Card>
        <CardContent className="py-6 text-sm text-foreground-light">
          {$t('Loading lifecycle providers…')}
        </CardContent>
      </Card>
    )
  if (capabilities.isError)
    return (
      <AlertError
        error={capabilities.error}
        subject={$t('Failed to load lifecycle capabilities')}
      />
    )
  const capability = findProjectCapability(capabilities.data, action)
  const label = lifecycleValueLabel(action)
  const canPlan = capability?.state === 'available' && (!label || value.trim() !== '')
  const handlePlan = () => {
    setError(undefined)
    setPlanned(undefined)
    createPlan.mutate({
      projectRef: project.ref,
      input: { action, parameters: lifecycleParameters(action, value, replicas) },
    })
  }
  const handleExecute = () => {
    if (!planned) return
    setError(undefined)
    execute.mutate({
      projectRef: project.ref,
      input: {
        plan: planned.plan,
        expectedGeneration: planned.expectedGeneration,
        idempotencyKey: crypto.randomUUID(),
      },
    })
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>{$t('Lifecycle providers')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-foreground-light">
          {$t(
            'Preview impact before any version-pinned lifecycle action. Unsupported providers remain unavailable.'
          )}
        </p>
        {error && <AlertError error={error} subject={$t('Lifecycle request failed')} />}
        <div className="grid gap-3 md:grid-cols-[minmax(220px,1fr)_minmax(220px,1fr)_auto]">
          <Select
            value={action}
            onValueChange={(next) => {
              setAction(next as Action)
              setPlanned(undefined)
              setValue('')
            }}
          >
            <SelectTrigger aria-label={$t('Lifecycle action')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {lifecycleActions.map((item) => (
                <SelectItem key={item} value={item}>
                  {$t(actionLabels[item])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {label && (
            <Input
              aria-label={$t(label)}
              placeholder={$t(label)}
              value={value}
              onChange={(event) => setValue(event.target.value)}
            />
          )}{' '}
          {action === 'runtime.scale' && (
            <Input
              aria-label={$t('Replica count')}
              type="number"
              min={1}
              max={64}
              value={replicas}
              onChange={(event) => setReplicas(Number(event.target.value))}
            />
          )}
          <Button
            disabled={!canPlan || createPlan.isPending}
            loading={createPlan.isPending}
            onClick={handlePlan}
          >
            {$t('Preview impact')}
          </Button>
        </div>
        {capability?.state !== 'available' && (
          <Alert variant="warning">
            <AlertTitle>{$t('Provider unavailable')}</AlertTitle>
            <AlertDescription>
              {capability?.blockers[0]?.message ??
                $t('The bound Agent does not advertise this versioned capability.')}
            </AlertDescription>
          </Alert>
        )}
        {planned && (
          <div className="space-y-3 rounded-md border p-4">
            <div className="flex flex-wrap gap-2">
              <Badge variant={planned.plan.impact.serviceInterruption ? 'warning' : 'secondary'}>
                {planned.plan.impact.serviceInterruption
                  ? $t('Service interruption')
                  : $t('No interruption expected')}
              </Badge>
              {planned.plan.requiresRecentAal2 && <Badge variant="warning">AAL2</Badge>}
              <Badge variant="secondary">{planned.plan.adapter}</Badge>
            </div>
            <p className="text-sm">
              {$t('Affected services')}:{' '}
              {planned.plan.impact.affectedServices.join(', ') || $t('None')}
            </p>
            <p className="text-sm">
              {$t('Data-loss risk')}: {planned.plan.impact.dataLossRisk}
            </p>
            <div>
              <p className="text-sm font-medium">{$t('Verification')}</p>
              <ul className="list-disc pl-5 text-sm text-foreground-light">
                {planned.plan.verification.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            <div>
              <p className="text-sm font-medium">{$t('Rollback and manual recovery')}</p>
              <ul className="list-disc pl-5 text-sm text-foreground-light">
                {[...planned.plan.rollback, ...planned.plan.manualIntervention].map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
            {planned.plan.requiresExplicitConfirmation && (
              <Button
                variant="danger"
                loading={execute.isPending}
                disabled={execute.isPending}
                onClick={handleExecute}
              >
                {$t('Confirm and execute')}
              </Button>
            )}
          </div>
        )}
      </CardContent>
      <CardFooter className="border-t text-xs text-foreground-muted">
        {$t(
          'Plans expire after 10 minutes and are single-use. A changed target version, binding, adapter, or generation requires a new plan.'
        )}
      </CardFooter>
    </Card>
  )
}
