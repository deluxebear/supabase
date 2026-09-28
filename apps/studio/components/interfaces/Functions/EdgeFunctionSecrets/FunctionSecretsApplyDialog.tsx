import { useState } from 'react'
import { Button, Checkbox, Label } from 'ui'
import { Admonition } from 'ui-patterns/Admonition'
import { ConfirmationModal } from 'ui-patterns/Dialogs/ConfirmationModal'

import { getAAL2UpgradePath } from '@/components/interfaces/Database/Backups/SelfPlatformBackupOperator.utils'
import { useMfaListFactorsQuery } from '@/data/profile/mfa-list-factors-query'
import {
  useApplyFunctionSecretsMutation,
  type FunctionSecretsApplyStatus,
} from '@/data/secrets/function-secrets-apply'
import { t as $t } from '@/lib/i18n'

type FunctionSecretsApplyDialogProps = {
  projectRef: string
  status: FunctionSecretsApplyStatus
  visible: boolean
  onClose: () => void
}

// [self-platform] Confirms delivering stored secrets to the Edge Functions
// runtime: explains the restart, which secrets are delivered, and asks the
// operator to hand the functions configuration to Fleet if it does not own it.
export const FunctionSecretsApplyDialog = ({
  projectRef,
  status,
  visible,
  onClose,
}: FunctionSecretsApplyDialogProps) => {
  const [isOwnershipConfirmed, setIsOwnershipConfirmed] = useState(false)
  const applyMutation = useApplyFunctionSecretsMutation({
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
      expectedGeneration: status.expectedGeneration,
      confirmOwnership: needsOwnership && isOwnershipConfirmed,
    })
  }

  return (
    <ConfirmationModal
      visible={visible}
      size="medium"
      title={$t('Apply Edge Function secrets')}
      confirmLabel={$t('Apply and restart Edge Functions')}
      confirmLabelLoading={$t('Applying')}
      loading={applyMutation.isPending}
      disabled={!canApply}
      onCancel={onClose}
      onConfirm={handleConfirm}
    >
      <div className="flex flex-col gap-4 text-sm">
        <p>
          {$t(
            "Fleet recreates the project's Edge Functions runtime with the saved secrets. Function requests fail for a few seconds while it restarts. If the runtime does not start, Fleet restores the previous secrets."
          )}
        </p>
        {status.sealedSecretNames.length > 0 && (
          <p className="text-foreground-light">
            {$t(
              "{{count}} secrets are encrypted for this stack's Fleet Agent and applied: {{names}}",
              {
                count: status.sealedSecretNames.length,
                names: status.sealedSecretNames.join(', '),
              }
            )}
          </p>
        )}
        {status.sealedSecretNames.length === 0 && status.skippedSecretNames.length === 0 && (
          <p className="text-foreground-light">
            {$t(
              'No custom secrets are saved. Applying removes the secrets Fleet delivered before.'
            )}
          </p>
        )}
        {status.skippedSecretNames.length > 0 && (
          <Admonition
            type="warning"
            title={$t('Secrets are not applied')}
            description={$t(
              "This stack's Fleet Agent has not published a key for receiving secrets. Upgrade the Agent, or set these in the stack environment: {{names}}",
              { names: status.skippedSecretNames.join(', ') }
            )}
          />
        )}
        {needsOwnership && (
          <div className="flex items-start gap-2">
            <Checkbox
              id="function-secrets-apply-ownership"
              checked={isOwnershipConfirmed}
              onCheckedChange={(checked) => setIsOwnershipConfirmed(checked === true)}
            />
            <Label htmlFor="function-secrets-apply-ownership" className="leading-normal">
              {$t(
                'Let Fleet manage Edge Functions for this project. Later Fleet applies replace manual changes to the Edge Functions secrets override.'
              )}
            </Label>
          </div>
        )}
        {needsAal2 && (
          <Admonition
            type="warning"
            title={$t('Verify your identity to apply')}
            description={$t(
              'Applying restarts the Edge Functions runtime and needs a recent MFA verification.'
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
            title={$t('Failed to apply Edge Function secrets')}
            description={applyMutation.error.message}
          />
        )}
      </div>
    </ConfirmationModal>
  )
}
