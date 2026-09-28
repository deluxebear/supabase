import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Button } from 'ui'
import { Admonition } from 'ui-patterns/Admonition'

import { FunctionSecretsApplyDialog } from './FunctionSecretsApplyDialog'
import { getConfigApplyNotice } from '@/components/interfaces/SelfPlatform/ConfigApplyNotice.utils'
import { functionSecretsApplyStatusQueryOptions } from '@/data/secrets/function-secrets-apply'
import { t as $t } from '@/lib/i18n'

// [self-platform] Fleet stores Edge Function secrets as desired state; they
// reach the running functions only through an explicit apply, which
// recreates the Edge Functions runtime. Renders nothing outside Fleet.
export const FunctionSecretsApplyNotice = ({
  projectRef,
  canApply,
}: {
  projectRef: string
  canApply: boolean
}) => {
  const [isApplyDialogOpen, setIsApplyDialogOpen] = useState(false)
  const { data: status } = useQuery(functionSecretsApplyStatusQueryOptions({ projectRef }))
  if (status === undefined) return null
  const notice = getConfigApplyNotice(status)
  const hasReservedSecrets = status.reservedSecretNames.length > 0
  if (notice.kind === 'hidden' && !hasReservedSecrets) return null

  return (
    <div className="space-y-4">
      {hasReservedSecrets && (
        <Admonition
          type="warning"
          title={$t('Some secrets are never applied')}
          description={$t(
            'These names are reserved by the Edge Functions runtime. Delete them and save the values under other names: {{names}}',
            { names: status.reservedSecretNames.join(', ') }
          )}
        />
      )}
      {notice.kind === 'applying' && (
        <Admonition
          type="note"
          title={$t('Applying Edge Function secrets')}
          description={$t(
            "Fleet is recreating the project's Edge Functions runtime with the saved secrets. This page updates when it finishes."
          )}
        />
      )}
      {notice.kind === 'saved-only' && (
        <Admonition type="warning" title={$t('Secrets are saved but not applied')}>
          <p className="leading-normal!">
            {$t(
              'Fleet stores these secrets for this project, but running functions do not receive them until they are applied.'
            )}
          </p>
          {notice.reason !== null && (
            <p className="leading-normal! text-foreground-lighter">{notice.reason}</p>
          )}
        </Admonition>
      )}
      {(notice.kind === 'pending' || notice.kind === 'failed') && (
        <Admonition
          type="warning"
          title={
            notice.kind === 'failed'
              ? $t('Secrets were not applied')
              : $t('Secrets are saved but not applied')
          }
        >
          <p className="leading-normal!">
            {notice.kind === 'failed'
              ? $t(
                  'The last apply did not finish, and running functions kept their previous secrets. Check the managed stack, then apply again.'
                )
              : $t('Running functions use the previous secrets until you apply the saved ones.')}
          </p>
          {notice.kind === 'failed' && notice.errorCode !== null && (
            <p className="leading-normal! text-foreground-lighter">
              {$t('Error code: {{code}}', { code: notice.errorCode })}
            </p>
          )}
          {canApply && (
            <Button variant="default" className="mt-2" onClick={() => setIsApplyDialogOpen(true)}>
              {notice.kind === 'failed' ? $t('Apply again') : $t('Apply to Edge Functions')}
            </Button>
          )}
        </Admonition>
      )}
      <FunctionSecretsApplyDialog
        projectRef={projectRef}
        status={status}
        visible={isApplyDialogOpen}
        onClose={() => setIsApplyDialogOpen(false)}
      />
    </div>
  )
}
