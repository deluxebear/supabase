import { PermissionAction } from '@supabase/shared-types/out/constants'
import { Plus } from 'lucide-react'
import { MouseEventHandler } from 'react'

import { ButtonTooltip } from '@/components/ui/ButtonTooltip'
import { useAsyncCheckPermissions } from '@/hooks/misc/useCheckPermissions'
import { t as $t } from '@/lib/i18n'

export const CreateBucketButton = ({
  onClick,
}: {
  onClick: MouseEventHandler<HTMLButtonElement>
}) => {
  const { can: canCreateBuckets } = useAsyncCheckPermissions(PermissionAction.STORAGE_WRITE, '*')

  return (
    <ButtonTooltip
      block
      size="tiny"
      variant="primary"
      className="w-fit"
      icon={<Plus size={14} />}
      disabled={!canCreateBuckets}
      onClick={onClick}
      tooltip={{
        content: {
          side: 'bottom',
          text: !canCreateBuckets ? 'You need additional permissions to create buckets' : undefined,
        },
      }}
    >
      {$t('New bucket')}
    </ButtonTooltip>
  )
}
