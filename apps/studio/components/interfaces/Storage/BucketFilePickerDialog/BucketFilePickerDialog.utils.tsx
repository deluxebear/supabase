import { QueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'

import { storageKeys } from '@/data/storage/keys'
import { t as $t } from '@/lib/i18n'
import { createProjectSupabaseClient } from '@/lib/project-supabase-client'

export async function uploadFilesToBucket({
  files,
  projectRef,
  hostEndpoint,
  bucketName,
  bucketId,
  currentPath,
  queryClient,
}: {
  files: File[]
  projectRef: string
  hostEndpoint: string
  bucketName: string
  bucketId: string
  currentPath: string
  queryClient: QueryClient
}) {
  if (files.length === 0) return

  const client = await createProjectSupabaseClient(projectRef, hostEndpoint)
  let successCount = 0

  for (const file of files) {
    const filePath = currentPath ? `${currentPath}/${file.name}` : file.name
    const { error } = await client.storage.from(bucketName).upload(filePath, file, { upsert: true })
    if (error) {
      toast.error(
        $t('Failed to upload {{value0}}: {{value1}}', { value0: file.name, value1: error.message })
      )
    } else {
      successCount++
    }
  }

  if (successCount > 0) {
    toast.success(
      $t('Successfully uploaded {{value0}} file{{value1}}', {
        value0: successCount,
        value1: successCount > 1 ? $t('s') : '',
      })
    )
    const queryKey = storageKeys.objects(projectRef, bucketId, '')
    await queryClient.refetchQueries({ queryKey, type: 'active' })
  }
}
