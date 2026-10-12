import { useState } from 'react'
import { Button, Checkbox, Label } from 'ui'
import { Admonition } from 'ui-patterns/Admonition'
import { ConfirmationModal } from 'ui-patterns/Dialogs/ConfirmationModal'

import { ENV_SERVICE_NAMES } from './EnvServiceApply.constants'
import { getAAL2UpgradePath } from '@/components/interfaces/Database/Backups/SelfPlatformBackupOperator.utils'
import {
  useApplyEnvServiceMutation,
  type EnvApplyService,
  type EnvServiceApplyStatus,
} from '@/data/config/env-service-apply'
import { useMfaListFactorsQuery } from '@/data/profile/mfa-list-factors-query'
import { t as $t } from '@/lib/i18n'

type EnvServiceApplyDialogProps = {
  projectRef: string
  service: EnvApplyService
  status: EnvServiceApplyStatus
  visible: boolean
  onClose: () => void
}

// [self-platform] Confirms applying stored PostgREST or Storage settings:
// explains the service restart and asks the operator to hand the service
// configuration to Fleet if it does not own it yet.
export const EnvServiceApplyDialog = ({
  projectRef,
  service,
  status,
  visible,
  onClose,
}: EnvServiceApplyDialogProps) => {
  const name = ENV_SERVICE_NAMES[service]
  const [isOwnershipConfirmed, setIsOwnershipConfirmed] = useState(false)
  const applyMutation = useApplyEnvServiceMutation({
    onSuccess: () => onClose(),
    onError: () => undefined,
  })
  const needsAal2 = applyMutation.error?.applyCode === 'aal2_required'
  const factorsQuery = useMfaListFactorsQuery({ enabled: needsAal2 })
  const hasMfaFactor = (factorsQuery.data?.totp.length ?? 0) > 0

  const needsOwnership = !status.isOwnedByFleet
  const canApply = !needsOwnership || isOwnershipConfirmed
  const aal2Href = `${getAAL2UpgradePath(hasMfaFactor)}?${new URLSearchParams({
    returnTo: typeof window === 'undefined' ? '/' : window.location.pathname,
    ...(hasMfaFactor ? { reauthenticate: 'true' } : {}),
  }).toString()}`

  const handleConfirm = () => {
    applyMutation.mutate({
      projectRef,
      service,
      expectedGeneration: status.expectedGeneration,
      confirmOwnership: needsOwnership && isOwnershipConfirmed,
    })
  }

  return (
    <ConfirmationModal
      visible={visible}
      size="medium"
      title={$t('Apply {{name}} settings', { name })}
      confirmLabel={$t('Apply and restart {{name}}', { name })}
      confirmLabelLoading={$t('Applying')}
      loading={applyMutation.isPending}
      disabled={!canApply}
      onCancel={onClose}
      onConfirm={handleConfirm}
    >
      <div className="flex flex-col gap-4 text-sm">
        <p>
          {$t(
            'Fleet recreates the {{name}} service with the saved settings. Requests to it fail for a few seconds while it restarts. If the new settings keep it from starting, Fleet restores the previous settings.',
            { name }
          )}
        </p>
        <p className="text-foreground-light">
          {$t('{{count}} saved settings will be applied.', { count: status.appliedFields.length })}
        </p>
        {needsOwnership && (
          <div className="flex items-start gap-2">
            <Checkbox
              id="env-service-apply-ownership"
              checked={isOwnershipConfirmed}
              onCheckedChange={(checked) => setIsOwnershipConfirmed(checked === true)}
            />
            <Label htmlFor="env-service-apply-ownership" className="leading-normal">
              {$t(
                'Let Fleet manage the {{name}} service configuration for this project. Later Fleet applies replace manual changes to its override.',
                { name }
              )}
            </Label>
          </div>
        )}
        {needsAal2 && (
          <Admonition
            type="warning"
            title={$t('Verify your identity to apply')}
            description={$t(
              'Applying restarts the {{name}} service and needs a recent MFA verification.',
              { name }
            )}
          >
            <Button asChild variant="default" className="mt-2">
              <a href={aal2Href}>{$t(hasMfaFactor ? 'Verify AAL2 again' : 'Set up MFA')}</a>
            </Button>
          </Admonition>
        )}
        {applyMutation.isError && !needsAal2 && (
          <Admonition
            type="destructive"
            title={$t('Failed to apply {{name}} settings', { name })}
            description={applyMutation.error.message}
          />
        )}
      </div>
    </ConfirmationModal>
  )
}
