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

import { t as $t } from '@/lib/i18n'

interface SmtpDisableConfirmationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => Promise<void>
  blockEditingOnReset?: boolean
}

export const SmtpDisableConfirmationDialog = ({
  open,
  onOpenChange,
  onConfirm,
  blockEditingOnReset = false,
}: SmtpDisableConfirmationDialogProps) => {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{$t('Disable custom SMTP')}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                {$t('Switching back to the built-in SMTP service will')}{' '}
                <strong className="text-foreground">
                  {$t('reset any custom email templates')}
                </strong>{' '}
                and{' '}
                <strong className="text-foreground">
                  {$t('reduce the email rate limit to 2 emails per hour')}
                </strong>
                .
              </p>
              {!blockEditingOnReset && (
                <p>
                  {$t(
                    "You won't be able to edit email templates until you set up custom SMTP again or upgrade your plan."
                  )}
                </p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{$t('Cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="warning" onClick={onConfirm}>
            {$t('Disable custom SMTP')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
