import * as Sentry from '@sentry/nextjs'
import { SupportCategories } from '@supabase/shared-types/out/constants'
import { safeLocalStorage, safeSessionStorage } from 'common'
import { useEffect } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
} from 'ui'
import { CollapsibleAlert } from 'ui-patterns/collapsible-alert'

import { SupportLink } from '../Support/SupportLink'
import { InlineLink, InlineLinkClassName } from '@/components/ui/InlineLink'
import { t as $t } from '@/lib/i18n'

interface SessionTimeoutModalProps {
  visible: boolean
  onClose: () => void
  redirectToSignIn: () => void
  /** Optional context so the support form can pre-populate when opened from this dialog */
  supportContext?: { projectRef?: string; orgSlug?: string }
}

export const SessionTimeoutModal = ({
  visible,
  onClose,
  redirectToSignIn,
  supportContext,
}: SessionTimeoutModalProps) => {
  useEffect(() => {
    if (visible) {
      Sentry.captureException(new Error('Session error detected'))
    }
  }, [visible])

  const handleClearStorage = () => {
    safeLocalStorage.clear()
    safeSessionStorage.clear()
    window.location.reload()
  }

  return (
    <AlertDialog
      open={visible}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <AlertDialogContent size="small">
        <AlertDialogHeader>
          <AlertDialogTitle>{$t('Session expired')}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-4">
              <p>{$t('Please sign in again to continue.')}</p>
              <CollapsibleAlert trigger="Having trouble?">
                <div className="space-y-3 text-foreground-light">
                  <p>
                    {$t(
                      'Try a different browser or disable extensions that block network requests. If the problem persists:'
                    )}
                  </p>
                  <Button variant="default" size="tiny" onClick={handleClearStorage}>
                    {$t('Clear site data and reload')}
                  </Button>
                  <p>
                    {$t('Still stuck?')}{' '}
                    <SupportLink
                      className={InlineLinkClassName}
                      queryParams={{
                        subject: 'Session expired',
                        category: SupportCategories.LOGIN_ISSUES,
                        ...(supportContext?.projectRef && {
                          projectRef: supportContext.projectRef,
                        }),
                        ...(supportContext?.orgSlug && { orgSlug: supportContext.orgSlug }),
                      }}
                      onClick={onClose}
                    >
                      {$t('Contact support')}
                    </SupportLink>{' '}
                    {$t('and include a')}{' '}
                    <InlineLink href="https://github.com/orgs/supabase/discussions/36540">
                      {$t('HAR file')}
                    </InlineLink>{' '}
                    {$t('from your session to help us investigate.')}
                  </p>
                </div>
              </CollapsibleAlert>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{$t('Close')}</AlertDialogCancel>
          <AlertDialogAction onClick={redirectToSignIn}>{$t('Sign in again')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
