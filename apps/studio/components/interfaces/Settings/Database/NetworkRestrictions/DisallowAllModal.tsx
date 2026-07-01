import { useParams } from 'common'
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

import InformationBox from '@/components/ui/InformationBox'
import { useNetworkRestrictionsApplyMutation } from '@/data/network-restrictions/network-retrictions-apply-mutation'
import { t as $t } from '@/lib/i18n'

interface DisallowAllModalProps {
  visible: boolean
  onClose: () => void
}

const DisallowAllModal = ({ visible, onClose }: DisallowAllModalProps) => {
  const { ref } = useParams()
  const { mutateAsync: applyNetworkRestrictions, isPending: isApplying } =
    useNetworkRestrictionsApplyMutation({ onSuccess: () => onClose() })

  const onSubmit = async () => {
    if (!ref) return console.error('Project ref is required')
    await applyNetworkRestrictions({
      projectRef: ref,
      dbAllowedCidrs: [],
      dbAllowedCidrsV6: [],
    })
  }

  return (
    <AlertDialog open={visible} onOpenChange={onClose}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{$t('Restrict access from all IP addresses')}</AlertDialogTitle>
          <AlertDialogDescription>
            <div className="flex flex-col space-y-4">
              <p>
                {$t(
                  "This will prevent any external IP addresses from accessing your project's database. Are you sure?"
                )}
              </p>
              <InformationBox
                defaultVisibility
                hideCollapse
                title={$t(
                  'Note: Restrictions only apply to direct connections to your database and connection pooler'
                )}
                description={$t(
                  'They do not currently apply to APIs offered over HTTPS, such as PostgREST, Storage, or Authentication.'
                )}
              />
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isApplying}>{$t('Cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={onSubmit} disabled={isApplying} loading={isApplying}>
            {$t('Confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export default DisallowAllModal
