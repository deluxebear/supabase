import { Loader2 } from 'lucide-react'
import { Button, KeyboardShortcut } from 'ui'

import { t as $t } from '@/lib/i18n'

interface SqlRunButtonProps {
  isDisabled?: boolean
  isExecuting?: boolean
  hasSelection?: boolean
  className?: string
  onClick: () => void
}

export const SqlRunButton = ({
  isDisabled = false,
  isExecuting = false,
  hasSelection = false,
  className,
  onClick,
}: SqlRunButtonProps) => {
  return (
    <Button
      onClick={onClick}
      disabled={isDisabled}
      variant="primary"
      size="tiny"
      data-testid="sql-run-button"
      iconRight={
        isExecuting ? (
          <Loader2 className="animate-spin" size={10} strokeWidth={1.5} />
        ) : (
          <KeyboardShortcut keys={['Meta', 'Enter']} variant="inline" />
        )
      }
      className={className}
    >
      {hasSelection ? $t('Run selected') : $t('Run')}
    </Button>
  )
}
