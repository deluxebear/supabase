import ConfirmationModal from 'ui-patterns/Dialogs/ConfirmationModal'

import { t as $t } from '@/lib/i18n'

interface DeployEdgeFunctionWarningModalProps {
  visible: boolean
  onCancel: () => void
  onConfirm: () => void
  isDeploying: boolean
}

export const DeployEdgeFunctionWarningModal = ({
  visible,
  onCancel,
  onConfirm,
  isDeploying,
}: DeployEdgeFunctionWarningModalProps) => {
  return (
    <ConfirmationModal
      visible={visible}
      size="medium"
      title={$t('Confirm to deploy updates')}
      confirmLabel="Deploy updates"
      confirmLabelLoading="Deploying updates"
      variant="warning"
      loading={isDeploying}
      onCancel={onCancel}
      onConfirm={onConfirm}
    >
      <p className="text-sm text-foreground-light">
        {$t(
          'Deploying will immediately update your live Edge Function for this project and cannot be rolled back automatically. Are you sure you want to deploy the changes?'
        )}
      </p>
    </ConfirmationModal>
  )
}
