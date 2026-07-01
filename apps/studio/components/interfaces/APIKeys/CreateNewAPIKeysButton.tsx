import { useParams } from 'common'
import { useState } from 'react'
import { toast } from 'sonner'
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
  Button,
} from 'ui'
import { Admonition } from 'ui-patterns/admonition'

import { useAPIKeyCreateMutation } from '@/data/api-keys/api-key-create-mutation'
import { t as $t } from '@/lib/i18n'

export const CreateNewAPIKeysButton = () => {
  const { ref: projectRef } = useParams()

  const [createKeysDialogOpen, setCreateKeysDialogOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const { mutateAsync: createAPIKey } = useAPIKeyCreateMutation({ onError: () => {} })

  const handleCreateNewApiKeys = async () => {
    if (!projectRef) return

    try {
      setError(null)

      // Create publishable key
      try {
        await createAPIKey({ projectRef, type: 'publishable', name: 'default' })
      } catch (error: any) {
        setError(`Failed to create the default publishable key: ${error.message}`)
        throw error
      }

      // Create secret key
      try {
        await createAPIKey({ projectRef, type: 'secret', name: 'default' })
      } catch (error: any) {
        setError(
          `The default publishable key was created, but the default secret key failed: ${error.message}`
        )
        throw error
      }

      setCreateKeysDialogOpen(false)
      toast.success($t('Successfully created a new set of API keys!'))
    } catch (error) {
      console.error('Failed to create API keys:', error)
      throw error
    }
  }

  return (
    <AlertDialog open={createKeysDialogOpen} onOpenChange={setCreateKeysDialogOpen}>
      <Button onClick={() => setCreateKeysDialogOpen(true)}>{$t('Create new API keys')}</Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{$t('Create new API keys')}</AlertDialogTitle>
          <AlertDialogDescription>
            {$t('This will create a default publishable key and a default secret key both named')}{' '}
            <code className="break-keep! text-code-inline">default</code>
            {$t('. These keys are required to connect your application to your Supabase project.')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <AlertDialogBody>
            <Admonition
              type="destructive"
              title={$t('Unable to create API keys')}
              description={error}
            />
          </AlertDialogBody>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>{$t('Cancel')}</AlertDialogCancel>
          <AlertDialogAction onClick={handleCreateNewApiKeys}>
            {$t('Create keys')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
