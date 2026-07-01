import type { MouseEventHandler } from 'react'
// End of third-party imports

import { Button, cn } from 'ui'

import { t as $t } from '@/lib/i18n'

interface SubmitButtonProps {
  isSubmitting: boolean
  userEmail: string
  onClick?: MouseEventHandler<HTMLButtonElement>
  className?: string
  descriptionClassName?: string
}

export function SubmitButton({
  isSubmitting,
  userEmail,
  onClick,
  className,
  descriptionClassName,
}: SubmitButtonProps) {
  return (
    <div className={cn('flex flex-col gap-3', className)}>
      <Button
        type="submit"
        size="small"
        block
        disabled={isSubmitting}
        loading={isSubmitting}
        onClick={onClick}
      >
        {$t('Send support request')}
      </Button>
      <p className={cn('text-xs text-foreground-lighter text-balance pr-4', descriptionClassName)}>
        {$t('We will contact you at')}{' '}
        <span className="text-foreground font-medium">{userEmail}</span>
        {$t('. Please ensure emails from supabase.com are allowed.')}
      </p>
    </div>
  )
}
