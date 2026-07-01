import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogBody,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from 'ui'
import { Admonition } from 'ui-patterns/admonition'

import type { JitUserRule } from './JitDbAccess.types'
import { t as $t } from '@/lib/i18n'

interface JitDbAccessDeleteDialogProps {
  user: JitUserRule | null
  isDeleting: boolean
  error?: string | null
  onClose: () => void
  onConfirm: () => unknown
}

export function JitDbAccessDeleteDialog({
  user,
  isDeleting = false,
  error,
  onClose,
  onConfirm,
}: JitDbAccessDeleteDialogProps) {
  const userDisplayName = user?.name?.trim() || user?.email || 'this user'

  return (
    <AlertDialog open={!!user} onOpenChange={(open) => !open && !isDeleting && onClose()}>
      <AlertDialogContent size="small">
        <AlertDialogHeader>
          <AlertDialogTitle>{$t('Delete temporary access rule')}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm">
              <p>
                {$t('Remove the temporary access rule for')}{' '}
                <strong className="text-foreground">{userDisplayName}</strong>?
              </p>
              <p>
                {$t(
                  'This revokes any assigned database roles for this member and removes their temporary access configuration.'
                )}
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <AlertDialogBody>
            <Admonition
              type="destructive"
              title={$t('Unable to delete temporary access rule')}
              description={error}
            />
          </AlertDialogBody>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>{$t('Cancel')}</AlertDialogCancel>
          <AlertDialogAction variant="danger" loading={isDeleting} onClick={onConfirm}>
            {$t('Delete rule')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
