import { Admonition } from 'ui-patterns/admonition'

import { t as $t } from '@/lib/i18n'

interface NoPermissionProps {
  resourceText: string
  isFullPage?: boolean
}

export const NoPermission = ({ resourceText, isFullPage = false }: NoPermissionProps) => {
  const NoPermissionMessage = (
    <Admonition
      type="warning"
      title={`You need additional permissions to ${resourceText}`}
      description={$t('Contact your organization owner or administrator for assistance.')}
    />
  )

  if (isFullPage) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="max-w-lg">{NoPermissionMessage}</div>
      </div>
    )
  } else {
    return NoPermissionMessage
  }
}
