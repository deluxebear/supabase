import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import ConfirmationModal from 'ui-patterns/Dialogs/ConfirmationModal'

import { organizationKeys } from '@/data/organizations/keys'
import { useMfaUnenrollMutation } from '@/data/profile/mfa-unenroll-mutation'
import { useRecoveryCodesUnenrollMutation } from '@/data/recovery-codes/recovery-codes-unenroll'
import { useLastVisitedOrganization } from '@/hooks/misc/useLastVisitedOrganization'
import { t as $t } from '@/lib/i18n'

interface DeleteFactorModalProps {
  visible: boolean
  factorId: string | null
  lastFactorToBeDeleted: boolean
  hasRecoveryCodes: boolean
  onClose: () => void
}

export const DeleteFactorModal = ({
  visible,
  factorId,
  lastFactorToBeDeleted,
  hasRecoveryCodes,
  onClose,
}: DeleteFactorModalProps) => {
  const queryClient = useQueryClient()

  const { lastVisitedOrganization } = useLastVisitedOrganization()

  const unenrollMFAMutation = useMfaUnenrollMutation({
    onSuccess: async () => {
      if (lastVisitedOrganization) {
        await queryClient.invalidateQueries({
          queryKey: organizationKeys.members(lastVisitedOrganization),
        })
      }
      toast.success($t('Successfully deleted factor'))
      onClose()
    },
  })

  const unenrollRecoveryCodesMutation = useRecoveryCodesUnenrollMutation({
    onSuccess: () => {
      if (!factorId) return // Should never happen
      unenrollMFAMutation.mutate({ factorId })
    },
  })

  const loading = unenrollMFAMutation.isPending || unenrollRecoveryCodesMutation.isPending

  return (
    <ConfirmationModal
      size="medium"
      visible={visible}
      variant={'destructive'}
      title={$t('Confirm to delete factor')}
      confirmLabel="Delete"
      confirmLabelLoading="Deleting"
      loading={loading}
      onCancel={onClose}
      onConfirm={() => {
        // If users have recovery codes and this is the last MFA for their account,
        // we must first delete the recovery codes (they don't make sense without any MFA)
        const shouldDeleteRecoveryCodes = lastFactorToBeDeleted && hasRecoveryCodes
        if (factorId && !shouldDeleteRecoveryCodes) {
          return unenrollMFAMutation.mutate({ factorId })
        }
        unenrollRecoveryCodesMutation.mutate()
      }}
      alert={{
        title: lastFactorToBeDeleted
          ? 'Multi-factor authentication will be disabled'
          : 'This action cannot be undone',
        description: lastFactorToBeDeleted
          ? 'There are no other factors that are set up once you delete this factor, as such your account will no longer be guarded by multi-factor authentication'
          : 'You will no longer be able to use this authenticator app for multi-factor authentication when signing in to the dashboard',
      }}
    >
      <p className="text-sm">{$t('Before deleting this factor, consider:')}</p>
      <ul className="text-sm text-foreground-light py-1 list-disc mx-4 space-y-1">
        {lastFactorToBeDeleted ? (
          <>
            <li>{$t('Adding another authenticator app as a factor prior to deleting')}</li>
            <li>{$t('Ensure that your account does not need multi-factor authentication')}</li>
            <li>
              {$t(
                'You will lose access to any organization that enforces multi-factor authentication'
              )}
            </li>
            {hasRecoveryCodes && <li>{$t('Your recovery codes will be deleted too')}</li>}
          </>
        ) : (
          <>
            <li>{$t('Your backup authenticator app is still available to use')}</li>
            <li>{$t('Adding another authenticator app thereafter as a backup')}</li>
          </>
        )}
      </ul>
    </ConfirmationModal>
  )
}
