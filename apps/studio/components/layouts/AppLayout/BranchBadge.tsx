import { Badge } from 'ui'

import type { Branch } from '@/data/branches/branches-query'
import { t as $t } from '@/lib/i18n'

interface BranchBadgeProps {
  branch: Branch | undefined
  isBranchingEnabled: boolean
}

export function BranchBadge({ branch, isBranchingEnabled }: BranchBadgeProps) {
  if (!isBranchingEnabled) {
    return (
      <Badge variant="warning" className="mt-px">
        {$t('Production')}
      </Badge>
    )
  }

  if (branch?.is_default) {
    return (
      <Badge variant="warning" className="mt-px">
        {$t('Production')}
      </Badge>
    )
  }

  if (branch?.persistent) {
    return (
      <Badge variant="success" className="mt-px">
        {$t('Persistent')}
      </Badge>
    )
  }

  return (
    <Badge variant="success" className="mt-px">
      {$t('Preview')}
    </Badge>
  )
}
