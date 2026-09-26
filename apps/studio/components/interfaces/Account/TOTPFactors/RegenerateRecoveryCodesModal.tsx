import { useState } from 'react'
import { Button } from 'ui'

import { RecoveryCodesModal } from './RecoveryCodesModal'
import { TextConfirmModal } from '@/components/ui/TextConfirmModalWrapper'
import { useRecoveryCodesRegenerateMutation } from '@/data/recovery-codes/recovery-codes-regenerate-mutation'
import { t as $t } from '@/lib/i18n'

export const RegenerateRecoveryCodesModal = () => {
  const [showConfirm, setShowConfirm] = useState(false)
  const [open, setOpen] = useState(false)

  const recoveryCodesRegenerateMutation = useRecoveryCodesRegenerateMutation({
    onSettled: () => {
      setShowConfirm(false)
      setOpen(true)
    },
  })

  return (
    <>
      <Button onClick={() => setShowConfirm(true)}>{$t('Regenerate my recovery codes')}</Button>
      <TextConfirmModal
        visible={showConfirm}
        size="small"
        variant="destructive"
        title={$t('Regenerate my recovery codes')}
        confirmPlaceholder="REGENERATE"
        confirmString="REGENERATE"
        confirmLabel="Regenerate"
        loading={recoveryCodesRegenerateMutation.isPending}
        onConfirm={() => {
          recoveryCodesRegenerateMutation.mutate()
        }}
        onCancel={() => setShowConfirm(false)}
      >
        <p className="text-sm">{$t("Your existing recovery codes won't work anymore.")}</p>
      </TextConfirmModal>
      <RecoveryCodesModal
        open={open}
        onOpenChange={(open) => setOpen(open)}
        mutation={recoveryCodesRegenerateMutation}
      />
    </>
  )
}
