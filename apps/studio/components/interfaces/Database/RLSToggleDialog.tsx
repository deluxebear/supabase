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

import { InlineLink } from '@/components/ui/InlineLink'
import { DOCS_URL } from '@/lib/constants'
import { t as $t } from '@/lib/i18n'

interface RLSToggleDialogProps {
  open: boolean
  tableName?: string
  isEnabled: boolean
  isSubmitting?: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void | Promise<void>
}

export function RLSToggleDialog({
  open,
  isEnabled,
  isSubmitting = false,
  onOpenChange,
  onConfirm,
}: RLSToggleDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {isEnabled ? 'Disable Row Level Security' : 'Enable Row Level Security'}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {isEnabled ? (
              <>
                {$t('This table will become publicly readable and writable.')}{' '}
                <span className="font-medium text-foreground">
                  {$t('Anyone can view, add, update, or delete data in this table')}
                </span>
                {$t(', and existing RLS policies will no longer apply.')}
              </>
            ) : (
              'RLS restricts table access until policies allow a request. Existing queries may stop returning rows until policies are added.'
            )}{' '}
            <InlineLink href={`${DOCS_URL}/guides/database/postgres/row-level-security`}>
              {$t('Learn more')}
            </InlineLink>
            .
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{$t('Cancel')}</AlertDialogCancel>
          <AlertDialogAction
            variant={isEnabled ? 'danger' : 'primary'}
            loading={isSubmitting}
            onClick={() => onConfirm()}
          >
            {isEnabled ? $t('Disable RLS') : $t('Enable RLS')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
