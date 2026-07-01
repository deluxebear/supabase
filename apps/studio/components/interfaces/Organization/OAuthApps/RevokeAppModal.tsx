import { useParams } from 'common'
import { Lock } from 'lucide-react'
import { toast } from 'sonner'
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
import { Admonition } from 'ui-patterns/admonition'

import { useAuthorizedAppRevokeMutation } from '@/data/oauth/authorized-app-revoke-mutation'
import type { AuthorizedApp } from '@/data/oauth/authorized-apps-query'
import { t as $t } from '@/lib/i18n'

export interface RevokeAppModalProps {
  selectedApp?: AuthorizedApp
  /** Optional Organization slug override for routes without a `slug` param (e.g. project integrations). */
  orgSlug?: string
  onClose: () => void
}

export const RevokeAppModal = ({
  selectedApp,
  orgSlug: slugOverride,
  onClose,
}: RevokeAppModalProps) => {
  const { slug: slugParam } = useParams()
  const orgSlug = slugOverride ?? slugParam
  const { mutateAsync: revokeAuthorizedApp } = useAuthorizedAppRevokeMutation({
    onSuccess: () => {
      toast.success(`Successfully revoked the app "${selectedApp?.name}"`)
      onClose()
    },
  })

  const onConfirmDelete = async () => {
    if (!orgSlug) return console.error('Organization slug is required')
    if (!selectedApp?.id) return console.error('App ID is required')
    await revokeAuthorizedApp({ orgSlug, id: selectedApp?.id })
  }

  return (
    <AlertDialog open={selectedApp !== undefined} onOpenChange={onClose}>
      <AlertDialogContent size="medium">
        <AlertDialogHeader>
          <AlertDialogTitle>{`Revoke access for ${selectedApp?.name}?`}</AlertDialogTitle>
          <AlertDialogDescription>
            <div className="flex flex-col space-y-2">
              <Admonition
                type="warning"
                title={$t('This action cannot be undone')}
                description={`${selectedApp?.name} will no longer have access to your organization's settings
          and projects.`}
              />
              <ul className="space-y-5">
                <li className="flex gap-3 text-sm">
                  <Lock size={14} className="shrink-0" />
                  <div>
                    <strong>{$t('Before you remove this app, consider:')}</strong>
                    <ul className="space-y-2 mt-2">
                      <li className="list-disc ml-4">
                        {$t(
                          'The application will no longer have access to your organization after being revoked.'
                        )}
                      </li>
                      <li className="list-disc ml-4">
                        {$t(
                          'This will remove the application for all members in your organization.'
                        )}
                      </li>
                      <li className="list-disc ml-4">
                        {$t(
                          'Restoring access will require an organization administrator to re-authorize the application.'
                        )}
                      </li>
                    </ul>
                  </div>
                </li>
              </ul>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{$t('Cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirmDelete}>{$t('Confirm')}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
