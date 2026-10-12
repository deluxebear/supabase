import { useState } from 'react'
import { Badge, Button, Checkbox, Label } from 'ui'
import { Admonition } from 'ui-patterns/Admonition'

import { getAAL2UpgradePath } from '@/components/interfaces/Database/Backups/SelfPlatformBackupOperator.utils'
import { AlertError } from '@/components/ui/AlertError'
import { useMfaListFactorsQuery } from '@/data/profile/mfa-list-factors-query'
import type { LifecyclePlanResponse } from '@/data/projects/project-lifecycle-mutations'
import { t as $t } from '@/lib/i18n'
import type { ResponseError } from '@/types'

type SelfPlatformLifecyclePlanReviewProps = {
  planned: LifecyclePlanResponse
  isExecuting: boolean
  executeError: ResponseError | null
  onExecute: (confirmOwnership: boolean) => void
}

// [self-platform] Shows the impact plan and, like Auth apply, asks the operator to
// hand the action's domain to Fleet before the first lifecycle action executes.
export const SelfPlatformLifecyclePlanReview = ({
  planned,
  isExecuting,
  executeError,
  onExecute,
}: SelfPlatformLifecyclePlanReviewProps) => {
  const { plan, ownership } = planned
  const [isOwnershipConfirmed, setIsOwnershipConfirmed] = useState(false)
  const needsAal2 = executeError?.errorType === 'aal2_required'
  const factorsQuery = useMfaListFactorsQuery({ enabled: needsAal2 })
  const hasMfaFactor = (factorsQuery.data?.totp.length ?? 0) > 0

  const needsOwnership = !ownership.isOwnedByFleet
  const canExecute = !isExecuting && (!needsOwnership || isOwnershipConfirmed)
  const aal2Href = `${getAAL2UpgradePath(hasMfaFactor)}?${new URLSearchParams({
    returnTo: typeof window === 'undefined' ? '/' : window.location.pathname,
    ...(hasMfaFactor ? { reauthenticate: 'true' } : {}),
  }).toString()}`

  return (
    <div className="space-y-3 rounded-md border p-4">
      <div className="flex flex-wrap gap-2">
        <Badge variant={plan.impact.serviceInterruption ? 'warning' : 'secondary'}>
          {plan.impact.serviceInterruption
            ? $t('Service interruption')
            : $t('No interruption expected')}
        </Badge>
        {plan.requiresRecentAal2 && <Badge variant="warning">AAL2</Badge>}
        <Badge variant="secondary">{plan.adapter}</Badge>
      </div>
      <p className="text-sm">
        {$t('Affected services')}: {plan.impact.affectedServices.join(', ') || $t('None')}
      </p>
      <p className="text-sm">
        {$t('Data-loss risk')}: {plan.impact.dataLossRisk}
      </p>
      <div>
        <p className="text-sm font-medium">{$t('Verification')}</p>
        <ul className="list-disc pl-5 text-sm text-foreground-light">
          {plan.verification.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
      <div>
        <p className="text-sm font-medium">{$t('Rollback and manual recovery')}</p>
        <ul className="list-disc pl-5 text-sm text-foreground-light">
          {[...plan.rollback, ...plan.manualIntervention].map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
      {needsOwnership && (
        <div className="flex items-start gap-2">
          <Checkbox
            id="lifecycle-ownership"
            checked={isOwnershipConfirmed}
            onCheckedChange={(checked) => setIsOwnershipConfirmed(checked === true)}
          />
          <Label htmlFor="lifecycle-ownership" className="text-sm leading-normal">
            {$t(
              'Let Fleet manage the {{domain}} domain for this project. Fleet then runs lifecycle actions in this domain directly on the stack.',
              { domain: ownership.domain }
            )}
          </Label>
        </div>
      )}
      {needsAal2 && (
        <Admonition
          type="warning"
          title={$t('Verify your identity to execute')}
          description={$t('This lifecycle action needs a recent MFA verification.')}
        >
          <Button asChild variant="default" className="mt-2">
            <a href={aal2Href}>{$t(hasMfaFactor ? 'Verify AAL2 again' : 'Set up MFA')}</a>
          </Button>
        </Admonition>
      )}
      {executeError && !needsAal2 && (
        <AlertError error={executeError} subject={$t('Lifecycle request failed')} />
      )}
      {plan.requiresExplicitConfirmation && (
        <Button
          variant="danger"
          loading={isExecuting}
          disabled={!canExecute}
          onClick={() => onExecute(needsOwnership && isOwnershipConfirmed)}
        >
          {$t('Confirm and execute')}
        </Button>
      )}
    </div>
  )
}
