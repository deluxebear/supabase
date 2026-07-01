import { useParams } from 'common'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from 'ui'
import { Admonition } from 'ui-patterns/admonition'

import { useOrganizationPaymentMethodDeleteMutation } from '@/data/organizations/organization-payment-method-delete-mutation'
import type { OrganizationPaymentMethod } from '@/data/organizations/organization-payment-methods-query'
import { t as $t } from '@/lib/i18n'

export interface DeletePaymentMethodModalProps {
  selectedPaymentMethod?: OrganizationPaymentMethod
  onClose: () => void
}

const DeletePaymentMethodModal = ({
  selectedPaymentMethod,
  onClose,
}: DeletePaymentMethodModalProps) => {
  const { slug } = useParams()

  const { mutateAsync: deletePayment } = useOrganizationPaymentMethodDeleteMutation({
    onSuccess: () => {
      toast.success(
        `Successfully removed payment method ending with ${selectedPaymentMethod?.card?.last4}`
      )
      onClose()
    },
  })

  const onConfirmDelete = async () => {
    if (!slug) return console.error('Slug is required')
    if (!selectedPaymentMethod) return console.error('Card ID is required')
    await deletePayment({ slug, cardId: selectedPaymentMethod.id })
  }

  return (
    <AlertDialog open={selectedPaymentMethod !== undefined} onOpenChange={() => onClose()}>
      <AlertDialogContent size="medium">
        <AlertDialogHeader>
          <AlertDialogTitle>{`Confirm to delete payment method ending with ${selectedPaymentMethod?.card?.last4}`}</AlertDialogTitle>
          <AlertDialogDescription>
            <Admonition
              type="default"
              title={$t('This will permanently delete your payment method.')}
              description={$t('You can re-add the payment method any time.')}
            />
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{$t('Cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirmDelete}>{$t('Confirm')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export default DeletePaymentMethodModal
