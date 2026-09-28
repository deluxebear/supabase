import { useState } from 'react'
import { Button, Checkbox, Label } from 'ui'
import { Admonition } from 'ui-patterns/Admonition'
import { ConfirmationModal } from 'ui-patterns/Dialogs/ConfirmationModal'

import { getAAL2UpgradePath } from '@/components/interfaces/Database/Backups/SelfPlatformBackupOperator.utils'
import {
  useApplyAuthConfigMutation,
  type AuthConfigApplyStatus,
} from '@/data/auth/auth-config-apply'
import { useMfaListFactorsQuery } from '@/data/profile/mfa-list-factors-query'
import { t as $t } from '@/lib/i18n'

type AuthConfigApplyDialogProps = {
  projectRef: string
  status: AuthConfigApplyStatus
  visible: boolean
  onClose: () => void
}

// [self-platform] Confirms applying stored Auth settings: explains the Auth
// restart, what is applied (secrets sealed to the Agent) and what is not, and asks the operator to hand the Auth
// service configuration to Fleet if it does not own it yet.
export const AuthConfigApplyDialog = ({
  projectRef,
  status,
  visible,
  onClose,
}: AuthConfigApplyDialogProps) => {
  const [isOwnershipConfirmed, setIsOwnershipConfirmed] = useState(false)
  const applyMutation = useApplyAuthConfigMutation({
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
      title={$t('Apply Auth settings')}
      confirmLabel={$t('Apply and restart Auth')}
      confirmLabelLoading={$t('Applying')}
      loading={applyMutation.isPending}
      disabled={!canApply}
      onCancel={onClose}
      onConfirm={handleConfirm}
    >
      <div className="flex flex-col gap-4 text-sm">
        <p>
          {$t(
            "Fleet recreates the project's Auth service with the saved settings. Sign-ins and token refreshes fail for a few seconds while it restarts. If the new settings keep Auth from starting, Fleet restores the previous settings."
          )}
        </p>
        <p className="text-foreground-light">
          {$t('{{count}} saved settings will be applied.', {
            count: status.appliedFields.length,
          })}
        </p>
        {status.sealedSecretFields.length > 0 && (
          <p className="text-foreground-light">
            {$t(
              "{{count}} secret settings are encrypted for this stack's Fleet Agent and applied: {{fields}}",
              {
                count: status.sealedSecretFields.length,
                fields: status.sealedSecretFields.join(', '),
              }
            )}
          </p>
        )}
        {status.skippedSecretFields.length > 0 && (
          <Admonition
            type="warning"
            title={$t('Secret settings are not applied')}
            description={$t(
              "This stack's Fleet Agent has not published a key for receiving secrets. Upgrade the Agent, or set these in the stack environment: {{fields}}",
              { fields: status.skippedSecretFields.join(', ') }
            )}
          />
        )}
        {needsOwnership && (
          <div className="flex items-start gap-2">
            <Checkbox
              id="auth-apply-ownership"
              checked={isOwnershipConfirmed}
              onCheckedChange={(checked) => setIsOwnershipConfirmed(checked === true)}
            />
            <Label htmlFor="auth-apply-ownership" className="leading-normal">
              {$t(
                'Let Fleet manage the Auth service configuration for this project. Later Fleet applies replace manual changes to the Auth override.'
              )}
            </Label>
          </div>
        )}
        {needsAal2 && (
          <Admonition
            type="warning"
            title={$t('Verify your identity to apply')}
            description={$t(
              'Applying restarts the Auth service and needs a recent MFA verification.'
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
            title={$t('Failed to apply Auth settings')}
            description={applyMutation.error.message}
          />
        )}
      </div>
    </ConfirmationModal>
  )
}
