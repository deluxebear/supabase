import { queryOptions } from '@tanstack/react-query'

import { databaseKeys } from './keys'
import {
  backupOperatorStatusSchema,
  type BackupOperatorStatus,
} from '@/lib/api/self-platform/backup-operator-status'
import { BASE_PATH } from '@/lib/constants'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

export type BackupOperatorStatusVariables = { projectRef?: string }
export type BackupOperatorStatusData = BackupOperatorStatus
export type BackupOperatorStatusError = Error

async function getBackupOperatorStatus(
  { projectRef }: BackupOperatorStatusVariables,
  signal?: AbortSignal
) {
  if (!projectRef) throw new Error('Project ref is required')
  const response = await fetch(
    `${BASE_PATH}/api/platform/database/${encodeURIComponent(projectRef)}/backup-operator/status`,
    { signal }
  )
  if (!response.ok) throw new Error(`Backup Operator status returned HTTP ${response.status}`)
  return backupOperatorStatusSchema.parse(await response.json())
}

export const backupOperatorStatusQueryOptions = ({ projectRef }: BackupOperatorStatusVariables) =>
  queryOptions({
    queryKey: databaseKeys.backupOperatorStatus(projectRef),
    queryFn: ({ signal }) => getBackupOperatorStatus({ projectRef }, signal),
    enabled: IS_SELF_PLATFORM && typeof projectRef !== 'undefined',
    refetchInterval: 30_000,
  })
