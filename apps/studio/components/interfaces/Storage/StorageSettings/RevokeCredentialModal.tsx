import { useParams } from 'common'
import { toast } from 'sonner'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogSection,
  DialogSectionSeparator,
  DialogTitle,
} from 'ui'

import { useS3AccessKeyDeleteMutation } from '@/data/storage/s3-access-key-delete-mutation'
import { t as $t } from '@/lib/i18n'

interface RevokeCredentialModalProps {
  visible: boolean
  selectedCredential?: { id: string; description: string }
  onClose: () => void
}

export const RevokeCredentialModal = ({
  visible,
  selectedCredential,
  onClose,
}: RevokeCredentialModalProps) => {
  const { ref: projectRef } = useParams()
  const { mutate: deleteS3AccessKey, isPending: isDeleting } = useS3AccessKeyDeleteMutation({
    onSuccess: () => {
      toast.success($t('Successfully revoked S3 access key'))
      onClose()
    },
  })

  return (
    <Dialog open={visible} onOpenChange={onClose}>
      <DialogContent size="small">
        <DialogHeader>
          <DialogTitle>
            {$t('Revoke credential')}{' '}
            <code className="text-sm">{selectedCredential?.description}</code>
          </DialogTitle>
        </DialogHeader>
        <DialogSectionSeparator />
        <DialogSection>
          <DialogDescription>
            {$t(
              'This action is irreversible and requests made with these access keys will stop working.'
            )}
          </DialogDescription>
        </DialogSection>
        <DialogFooter className="flex justify-end gap-x-1">
          <Button variant="outline" onClick={() => onClose()}>
            {$t('Cancel')}
          </Button>
          <Button
            variant="danger"
            loading={isDeleting}
            onClick={async () => {
              if (!selectedCredential) return
              deleteS3AccessKey({ id: selectedCredential.id, projectRef })
            }}
          >
            {$t('Yes, revoke access keys')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
