import { queryOptions } from '@tanstack/react-query'

import { isActiveBackupOperatorJob } from './backup-operator-job.utils'
import { backupOperatorKeys } from './keys'
import { constructHeaders } from '@/data/fetchers'
import {
  backupPolicySchema,
  operatorBackupsSchema,
  operatorClusterSchema,
  operatorJobSchema,
  operatorPITRSchema,
  restorePlanSchema,
} from '@/lib/api/self-platform/backup-operator-client'
import { BASE_PATH } from '@/lib/constants'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

export type BackupOperatorVariables = { projectRef?: string }
export type BackupOperatorJobVariables = BackupOperatorVariables & { jobId?: string }
export type BackupOperatorPlanVariables = BackupOperatorVariables & { planId?: string }
export type BackupOperatorError = Error

async function getOperatorCluster({ projectRef }: BackupOperatorVariables, signal?: AbortSignal) {
  return operatorClusterSchema.parse(await getOperatorResource(projectRef, 'cluster', signal))
}
export type OperatorClusterData = Awaited<ReturnType<typeof getOperatorCluster>>
export const operatorClusterQueryOptions = ({ projectRef }: BackupOperatorVariables) =>
  queryOptions({
    queryKey: backupOperatorKeys.cluster(projectRef),
    queryFn: ({ signal }) => getOperatorCluster({ projectRef }, signal),
    enabled: IS_SELF_PLATFORM && typeof projectRef !== 'undefined',
    refetchInterval: 30_000,
  })

async function getOperatorPITR({ projectRef }: BackupOperatorVariables, signal?: AbortSignal) {
  return operatorPITRSchema.parse(await getOperatorResource(projectRef, 'pitr', signal))
}
export type OperatorPITRData = Awaited<ReturnType<typeof getOperatorPITR>>
export const operatorPITRQueryOptions = ({ projectRef }: BackupOperatorVariables) =>
  queryOptions({
    queryKey: backupOperatorKeys.pitr(projectRef),
    queryFn: ({ signal }) => getOperatorPITR({ projectRef }, signal),
    enabled: IS_SELF_PLATFORM && typeof projectRef !== 'undefined',
    refetchInterval: 30_000,
  })

async function getOperatorResource(
  projectRef: string | undefined,
  path: string,
  signal?: AbortSignal
) {
  if (!projectRef) throw new Error('Project ref is required')
  const headers = await constructHeaders()
  const response = await fetch(
    `${BASE_PATH}/api/platform/database/${encodeURIComponent(projectRef)}/backup-operator/${path}`,
    { headers, signal }
  )
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new Error(
      payload && typeof payload === 'object' && 'message' in payload
        ? String(payload.message)
        : `Backup Operator returned HTTP ${response.status}`
    )
  }
  return payload
}

async function getBackupPolicy({ projectRef }: BackupOperatorVariables, signal?: AbortSignal) {
  return backupPolicySchema.parse(await getOperatorResource(projectRef, 'policy', signal))
}
export type BackupPolicyData = Awaited<ReturnType<typeof getBackupPolicy>>
export const backupPolicyQueryOptions = ({ projectRef }: BackupOperatorVariables) =>
  queryOptions({
    queryKey: backupOperatorKeys.policy(projectRef),
    queryFn: ({ signal }) => getBackupPolicy({ projectRef }, signal),
    enabled: IS_SELF_PLATFORM && typeof projectRef !== 'undefined',
  })

async function getOperatorBackups({ projectRef }: BackupOperatorVariables, signal?: AbortSignal) {
  return operatorBackupsSchema.parse(await getOperatorResource(projectRef, 'backups', signal))
}
export type OperatorBackupsData = Awaited<ReturnType<typeof getOperatorBackups>>
export const operatorBackupsQueryOptions = ({ projectRef }: BackupOperatorVariables) =>
  queryOptions({
    queryKey: backupOperatorKeys.backups(projectRef),
    queryFn: ({ signal }) => getOperatorBackups({ projectRef }, signal),
    enabled: IS_SELF_PLATFORM && typeof projectRef !== 'undefined',
    refetchInterval: 30_000,
  })

async function getOperatorJob(
  { projectRef, jobId }: BackupOperatorJobVariables,
  signal?: AbortSignal
) {
  if (!jobId) throw new Error('Job ID is required')
  return operatorJobSchema.parse(await getOperatorResource(projectRef, `jobs/${jobId}`, signal))
}
export type OperatorJobData = Awaited<ReturnType<typeof getOperatorJob>>
export const operatorJobQueryOptions = ({ projectRef, jobId }: BackupOperatorJobVariables) =>
  queryOptions({
    queryKey: backupOperatorKeys.job(projectRef, jobId),
    queryFn: ({ signal }) => getOperatorJob({ projectRef, jobId }, signal),
    enabled: IS_SELF_PLATFORM && typeof projectRef !== 'undefined' && typeof jobId !== 'undefined',
    refetchInterval: ({ state }) => (isActiveBackupOperatorJob(state.data?.state) ? 2_000 : false),
  })

async function getRestorePlan(
  { projectRef, planId }: BackupOperatorPlanVariables,
  signal?: AbortSignal
) {
  if (!planId) throw new Error('Restore plan ID is required')
  return restorePlanSchema.parse(
    await getOperatorResource(projectRef, `restore-plans/${planId}`, signal)
  )
}
export type RestorePlanData = Awaited<ReturnType<typeof getRestorePlan>>
export const restorePlanQueryOptions = ({ projectRef, planId }: BackupOperatorPlanVariables) =>
  queryOptions({
    queryKey: backupOperatorKeys.plan(projectRef, planId),
    queryFn: ({ signal }) => getRestorePlan({ projectRef, planId }, signal),
    enabled: IS_SELF_PLATFORM && typeof projectRef !== 'undefined' && typeof planId !== 'undefined',
  })
