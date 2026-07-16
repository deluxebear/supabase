import { queryOptions } from '@tanstack/react-query'

import { databaseKeys } from './keys'
import {
  fetchBackupOperator,
  retryBackupOperatorQuery,
} from '@/data/backup-operator/backup-operator-fetch'
import {
  backupOperatorStatusSchema,
  type BackupOperatorStatus,
} from '@/lib/api/self-platform/backup-operator-status.shared'
import { BASE_PATH } from '@/lib/constants'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'
import { ResponseError } from '@/types'

export type BackupOperatorStatusVariables = { projectRef?: string }
export type BackupOperatorStatusData = BackupOperatorStatus
export type BackupOperatorStatusError = ResponseError

export async function getBackupOperatorStatus(
  { projectRef }: BackupOperatorStatusVariables,
  signal?: AbortSignal
) {
  if (!projectRef) throw new Error('Project ref is required')
  const response = await fetchBackupOperator(
    `${BASE_PATH}/api/platform/database/${encodeURIComponent(projectRef)}/backup-operator/status`,
    { signal }
  )
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new ResponseError(
      payload && typeof payload === 'object' && 'message' in payload
        ? String(payload.message)
        : `Backup Operator status returned HTTP ${response.status}`,
      response.status,
      response.headers.get('X-Request-Id') ?? undefined
    )
  }
  return backupOperatorStatusSchema.parse(payload)
}

export const backupOperatorStatusQueryOptions = ({ projectRef }: BackupOperatorStatusVariables) =>
  queryOptions({
    queryKey: databaseKeys.backupOperatorStatus(projectRef),
    queryFn: ({ signal }) => getBackupOperatorStatus({ projectRef }, signal),
    enabled: IS_SELF_PLATFORM && typeof projectRef !== 'undefined',
    refetchInterval: 30_000,
    retry: retryBackupOperatorQuery,
  })
