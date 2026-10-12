import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Button } from 'ui'
import { Admonition } from 'ui-patterns/Admonition'

import { getConfigApplyNotice } from './ConfigApplyNotice.utils'
import { ENV_SERVICE_NAMES } from './EnvServiceApply.constants'
import { EnvServiceApplyDialog } from './EnvServiceApplyDialog'
import {
  envServiceApplyStatusQueryOptions,
  type EnvApplyService,
} from '@/data/config/env-service-apply'
import { t as $t } from '@/lib/i18n'

// [self-platform] Fleet stores PostgREST and Storage settings as desired state;
// they reach the running service only through an explicit apply. Shown on the
// settings pages so a save is never read as a live change.
export const EnvServiceApplyNotice = ({
  projectRef,
  service,
}: {
  projectRef: string
  service: EnvApplyService
}) => {
  const [isApplyDialogOpen, setIsApplyDialogOpen] = useState(false)
  const { data: status } = useQuery(envServiceApplyStatusQueryOptions({ projectRef, service }))
  const notice = getConfigApplyNotice(status)
  const name = ENV_SERVICE_NAMES[service]

  if (notice.kind === 'hidden') return null

  if (notice.kind === 'applying') {
    return (
      <Admonition
        type="note"
        className="mb-4"
        title={$t('Applying {{name}} settings', { name })}
        description={$t(
          'Fleet is recreating the {{name}} service with the saved settings. This page updates when it finishes.',
          { name }
        )}
      />
    )
  }

  if (notice.kind === 'saved-only') {
    return (
      <Admonition
        type="warning"
        className="mb-4"
        title={$t('{{name}} settings are saved but not applied', { name })}
      >
        <p className="leading-normal!">
          {$t(
            'Fleet stores these settings for this project, but the {{name}} service keeps running with its current configuration. To change it now, update its environment on the managed stack and restart the service.',
            { name }
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
        className="mb-4"
        title={
          isFailed
            ? $t('{{name}} settings were not applied', { name })
            : $t('{{name}} settings are saved but not applied', { name })
        }
      >
        <p className="leading-normal!">
          {isFailed
            ? $t(
                'The last apply did not finish, and the {{name}} service kept its previous configuration. Check the managed stack, then apply again.',
                { name }
              )
            : $t(
                'The {{name}} service keeps running with its current configuration until you apply the saved settings.',
                { name }
              )}
        </p>
        {isFailed && notice.errorCode !== null && (
          <p className="leading-normal! text-foreground-lighter">
            {$t('Error code: {{code}}', { code: notice.errorCode })}
          </p>
        )}
        {status !== undefined && (
          <Button variant="default" className="mt-2" onClick={() => setIsApplyDialogOpen(true)}>
            {isFailed ? $t('Apply again') : $t('Apply to {{name}} service', { name })}
          </Button>
        )}
      </Admonition>
      {status !== undefined && (
        <EnvServiceApplyDialog
          projectRef={projectRef}
          service={service}
          status={status}
          visible={isApplyDialogOpen}
          onClose={() => setIsApplyDialogOpen(false)}
        />
      )}
    </>
  )
}
