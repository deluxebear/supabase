import { useState } from 'react'
import { Button } from 'ui'

import { TextConfirmModal } from '@/components/ui/TextConfirmModalWrapper'
import { useRecoveryCodesUnenrollMutation } from '@/data/recovery-codes/recovery-codes-unenroll'
import { t as $t } from '@/lib/i18n'

export const UnenrollRecoveryCodesModal = () => {
  const [showConfirm, setShowConfirm] = useState(false)
  const recoveryCodesGenerateMutation = useRecoveryCodesUnenrollMutation({
    onSuccess: () => {
      setShowConfirm(false)
    },
  })

  return (
    <>
      <Button onClick={() => setShowConfirm(true)}>{$t('Delete my recovery codes')}</Button>
      <TextConfirmModal
        visible={showConfirm}
        size="small"
        variant="destructive"
        title={$t('Delete my recovery codes')}
        confirmPlaceholder="DELETE"
        confirmString="DELETE"
        confirmLabel="Delete"
        loading={recoveryCodesGenerateMutation.isPending}
        onConfirm={() => recoveryCodesGenerateMutation.mutate()}
        onCancel={() => setShowConfirm(false)}
      >
        <p className="text-sm">
          {$t("Your recovery codes won't work anymore. Make sure to regenerate them if needed.")}
        </p>
      </TextConfirmModal>
    </>
  )
}
