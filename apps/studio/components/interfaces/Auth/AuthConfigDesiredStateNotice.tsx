import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Button } from 'ui'
import { Admonition } from 'ui-patterns/Admonition'

import { AuthConfigApplyDialog } from './AuthConfigApplyDialog'
import { getConfigApplyNotice } from '@/components/interfaces/SelfPlatform/ConfigApplyNotice.utils'
import { authConfigApplyStatusQueryOptions } from '@/data/auth/auth-config-apply'
import { t as $t } from '@/lib/i18n'

// shrink-0: rendered directly inside ProjectLayout's flex-col <main>, where a
// tall page would otherwise squash the notice down to a clipped title.
const NOTICE_CLASS_NAME = 'shrink-0 rounded-none border-x-0 border-t-0 px-6'

// [self-platform] Fleet stores Auth settings as desired state; they reach the
// running Auth service only through an explicit apply. Shown on Auth
// configuration pages so a save is never read as a live change.
export const AuthConfigDesiredStateNotice = ({ projectRef }: { projectRef: string }) => {
  const [isApplyDialogOpen, setIsApplyDialogOpen] = useState(false)
  const { data: status } = useQuery(authConfigApplyStatusQueryOptions({ projectRef }))
  const notice = getConfigApplyNotice(status)

  if (notice.kind === 'hidden') return null

  if (notice.kind === 'applying') {
    return (
      <Admonition
        type="note"
        className={NOTICE_CLASS_NAME}
        title={$t('Applying Auth settings')}
        description={$t(
          "Fleet is recreating the project's Auth service with the saved settings. This page updates when it finishes."
        )}
      />
    )
  }

  if (notice.kind === 'saved-only') {
    return (
      <Admonition
        type="warning"
        className={NOTICE_CLASS_NAME}
        title={$t('Auth settings are saved but not applied')}
      >
        <p className="leading-normal!">
          {$t(
            "Fleet stores these settings for this project, but the project's Auth service keeps running with its current configuration. To change it now, update the Auth environment on the managed stack and restart the Auth service."
          )}
        </p>
        {notice.reason !== null && (
          <p className="leading-normal! text-foreground-lighter">{notice.reason}</p>
        )}
      </Admonition>
    )
  }

  const isFailed = notice.kind === 'failed'
  return (
    <>
      <Admonition
        type="warning"
        className={NOTICE_CLASS_NAME}
        title={
          isFailed
            ? $t('Auth settings were not applied')
            : $t('Auth settings are saved but not applied')
        }
      >
        <p className="leading-normal!">
          {isFailed
            ? $t(
                'The last apply did not finish, and the Auth service kept its previous configuration. Check the managed stack, then apply again.'
              )
            : $t(
                "The project's Auth service keeps running with its current configuration until you apply the saved settings."
              )}
        </p>
        {isFailed && notice.errorCode !== null && (
          <p className="leading-normal! text-foreground-lighter">
            {$t('Error code: {{code}}', { code: notice.errorCode })}
          </p>
        )}
        {status !== undefined && (
          <Button variant="default" className="mt-2" onClick={() => setIsApplyDialogOpen(true)}>
            {isFailed ? $t('Apply again') : $t('Apply to Auth service')}
          </Button>
        )}
      </Admonition>
      {status !== undefined && (
        <AuthConfigApplyDialog
          projectRef={projectRef}
          status={status}
          visible={isApplyDialogOpen}
          onClose={() => setIsApplyDialogOpen(false)}
        />
      )}
    </>
  )
}
