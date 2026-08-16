import { type PropsWithChildren } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from 'ui'

import { t as $t } from '@/lib/i18n'

interface SSLEnforcementConfirmDialogProps {
  isTargetEnforced: boolean
  isSubmitting: boolean
  onConfirm: () => Promise<void>
}

export const SSLEnforcementConfirmDialog = ({
  isTargetEnforced,
  isSubmitting,
  onConfirm,
  children,
}: PropsWithChildren<SSLEnforcementConfirmDialogProps>) => {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{children}</AlertDialogTrigger>
      <AlertDialogContent size="medium">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {$t('Updating SSL enforcement involves a brief downtime')}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {$t(
              'A database restart is required for SSL enforcement changes to take place, and this involves a few minutes of downtime. Confirm to proceed now?'
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isSubmitting}>{$t('Cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="warning" disabled={isSubmitting} onClick={onConfirm}>
            {isTargetEnforced ? 'Enable SSL' : 'Disable SSL'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
