import { Button } from 'ui'

import { useStripeSyncStatus } from './useStripeSyncStatus'
import { AlertError } from '@/components/ui/AlertError'
import { t as $t } from '@/lib/i18n'

export const InstallationError = ({
  error,
  handleUninstall,
  handleOpenInstallSheet,
  isUpgrade,
  installing,
  uninstalling,
}: {
  error: 'install' | 'uninstall'
  handleUninstall: () => void
  handleOpenInstallSheet: () => void
  isUpgrade?: boolean
  installing?: boolean
  uninstalling?: boolean
}) => {
  const {
    schemaComment: { errorMessage },
  } = useStripeSyncStatus()

  if (error === 'uninstall') {
    return (
      <AlertError
        layout="horizontal"
        subject="Failed to uninstall Stripe Sync Engine"
        error={errorMessage ? { message: errorMessage } : undefined}
        description={$t(
          'There was an error during the uninstallation of the Stripe Sync Engine, please try again. If the problem persists, contact support.'
        )}
        additionalActions={
          <Button onClick={handleUninstall} disabled={uninstalling} loading={uninstalling}>
            {$t('Retry uninstallation')}
          </Button>
        }
      />
    )
  }

  if (error === 'install') {
    return (
      <AlertError
        subject={
          isUpgrade
            ? 'Failed to upgrade Stripe Sync Engine'
            : 'Failed to install Stripe Sync Engine'
        }
        error={errorMessage ? { message: errorMessage } : undefined}
        description={
          isUpgrade
            ? $t(
                'There was an error during the upgrade of the Stripe Sync Engine, please try again. If the problem persists, contact support.'
              )
            : $t(
                'There was an error during the installation of the Stripe Sync Engine, please try reinstalling the integration. If the problem persists, contact support.'
              )
        }
        additionalActions={
          <Button onClick={handleOpenInstallSheet} disabled={installing} loading={installing}>
            {isUpgrade ? $t('Retry upgrade') : $t('Retry installation')}
          </Button>
        }
      />
    )
  }

  return null
}
