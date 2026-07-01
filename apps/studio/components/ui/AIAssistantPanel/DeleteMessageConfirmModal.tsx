import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogSection,
  DialogSectionSeparator,
  DialogTitle,
} from 'ui'

import { t as $t } from '@/lib/i18n'

type DeleteMessageConfirmModalProps = {
  visible: boolean
  onConfirm: () => void
  onCancel: () => void
}

export const DeleteMessageConfirmModal = ({
  visible,
  onConfirm,
  onCancel,
}: DeleteMessageConfirmModalProps) => {
  const onOpenChange = (open: boolean) => {
    if (!open) onCancel()
  }

  return (
    <Dialog open={visible} onOpenChange={onOpenChange}>
      <DialogContent size="small">
        <DialogHeader padding="small">
          <DialogTitle>{$t('Delete Message')}</DialogTitle>
        </DialogHeader>

        <DialogSectionSeparator />

        <DialogSection padding="small">
          <p className="text-sm text-foreground-light">
            {$t(
              'Are you sure you want to delete this message and all subsequent messages? This action cannot be undone.'
            )}
          </p>
        </DialogSection>

        <DialogFooter padding="small">
          <Button variant="default" onClick={onCancel}>
            {$t('Cancel')}
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            {$t('Delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
