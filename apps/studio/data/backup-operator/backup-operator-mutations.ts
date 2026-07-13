import { useMutation, useQueryClient, type UseMutationOptions } from '@tanstack/react-query'
import { toast } from 'sonner'

import { backupOperatorKeys } from './keys'
import { constructHeaders } from '@/data/fetchers'
import {
  backupPolicySchema,
  operatorClusterSchema,
  operatorJobSchema,
  restorePlanSchema,
} from '@/lib/api/self-platform/backup-operator-client'
import { BASE_PATH } from '@/lib/constants'
import { uuidv4 } from '@/lib/helpers'
import { t as $t } from '@/lib/i18n'

export class OperatorMutationError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly correlationId?: string,
    readonly retryable?: boolean,
    readonly details?: unknown
  ) {
    super(message)
    this.name = 'OperatorMutationError'
  }
}

async function mutateOperator(
  projectRef: string,
  path: string,
  method: 'POST' | 'PUT',
  body: unknown,
  idempotencyKey?: string
) {
  if (!projectRef) throw new Error('Project ref is required')
  const headers = await constructHeaders({
    'Content-Type': 'application/json',
    ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
  })
  const response = await fetch(
    `${BASE_PATH}/api/platform/database/${encodeURIComponent(projectRef)}/backup-operator/${path}`,
    { method, headers, body: JSON.stringify(body) }
  )
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw new OperatorMutationError(
      payload && typeof payload === 'object' && 'message' in payload
        ? String(payload.message)
        : `Backup Operator returned HTTP ${response.status}`,
      payload && typeof payload === 'object' && 'code' in payload
        ? String(payload.code)
        : undefined,
      payload && typeof payload === 'object' && 'correlation_id' in payload
        ? String(payload.correlation_id)
        : (response.headers.get('x-correlation-id') ?? undefined),
      payload && typeof payload === 'object' && 'retryable' in payload
        ? Boolean(payload.retryable)
        : undefined,
      payload && typeof payload === 'object' && 'details' in payload ? payload.details : undefined
    )
  }
  return payload
}

export type BackupPolicyUpdateVariables = {
  projectRef: string
  payload: {
    enabled: boolean
    retentionDays: number
    fullSchedule: string
    diffSchedule: string | null
    incrSchedule: string | null
    backupFrom: 'primary' | 'standby'
    designatedStandby: string | null
    repositoryId: string
    maxStandbyLagBytes: number
  }
}

export const useClusterDiscoverMutation = (
  options: Omit<
    UseMutationOptions<
      ReturnType<typeof operatorClusterSchema.parse>,
      OperatorMutationError,
      { projectRef: string }
    >,
    'mutationFn'
  > = {}
) => {
  const queryClient = useQueryClient()
  return useMutation({
    ...options,
    mutationFn: async ({ projectRef }) =>
      operatorClusterSchema.parse(await mutateOperator(projectRef, 'discover', 'POST', {})),
    async onSuccess(data, variables, context) {
      queryClient.setQueryData(backupOperatorKeys.cluster(variables.projectRef), data)
      await options.onSuccess?.(data, variables, context)
    },
    onError(error, variables, context) {
      if (options.onError) options.onError(error, variables, context)
      else toast.error($t('Failed to refresh discovery: {{message}}', { message: error.message }))
    },
  })
}

export const useManualBackupMutation = (
  options: Omit<
    UseMutationOptions<
      ReturnType<typeof operatorJobSchema.parse>,
      OperatorMutationError,
      { projectRef: string; type: 'full' | 'diff' | 'incr' }
    >,
    'mutationFn'
  > = {}
) => {
  const queryClient = useQueryClient()
  return useMutation({
    ...options,
    mutationFn: async ({ projectRef, type }) =>
      operatorJobSchema.parse(
        await mutateOperator(projectRef, 'backups', 'POST', { type }, uuidv4())
      ),
    async onSuccess(data, variables, context) {
      queryClient.setQueryData(backupOperatorKeys.job(variables.projectRef, data.id), data)
      await queryClient.invalidateQueries({
        queryKey: backupOperatorKeys.backups(variables.projectRef),
      })
      await options.onSuccess?.(data, variables, context)
    },
    onError(error, variables, context) {
      if (options.onError) options.onError(error, variables, context)
      else toast.error($t('Failed to start backup: {{message}}', { message: error.message }))
    },
  })
}

export const usePITRMutation = (
  options: Omit<
    UseMutationOptions<
      unknown,
      OperatorMutationError,
      { projectRef: string; action: 'enable' | 'disable'; repositoryId?: string }
    >,
    'mutationFn'
  > = {}
) => {
  const queryClient = useQueryClient()
  return useMutation({
    ...options,
    mutationFn: async ({ projectRef, action, repositoryId }) =>
      mutateOperator(
        projectRef,
        `pitr/${action}`,
        'POST',
        action === 'enable' ? { repositoryId } : {}
      ),
    async onSuccess(data, variables, context) {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: backupOperatorKeys.pitr(variables.projectRef) }),
        queryClient.invalidateQueries({
          queryKey: backupOperatorKeys.policy(variables.projectRef),
        }),
      ])
      await options.onSuccess?.(data, variables, context)
    },
    onError(error, variables, context) {
      if (options.onError) options.onError(error, variables, context)
      else toast.error($t('Failed to update PITR: {{message}}', { message: error.message }))
    },
  })
}

export const useJobResolutionMutation = (
  options: Omit<
    UseMutationOptions<
      ReturnType<typeof operatorJobSchema.parse>,
      OperatorMutationError,
      { projectRef: string; jobId: string; action: 'retry' | 'cancel' }
    >,
    'mutationFn'
  > = {}
) => {
  const queryClient = useQueryClient()
  return useMutation({
    ...options,
    mutationFn: async ({ projectRef, jobId, action }) =>
      operatorJobSchema.parse(
        await mutateOperator(projectRef, `jobs/${jobId}/${action}`, 'POST', {})
      ),
    async onSuccess(data, variables, context) {
      queryClient.setQueryData(backupOperatorKeys.job(variables.projectRef, variables.jobId), data)
      await options.onSuccess?.(data, variables, context)
    },
    onError(error, variables, context) {
      if (options.onError) options.onError(error, variables, context)
      else toast.error($t('Failed to update job: {{message}}', { message: error.message }))
    },
  })
}
export const useBackupPolicyUpdateMutation = (
  options: Omit<
    UseMutationOptions<
      ReturnType<typeof backupPolicySchema.parse>,
      OperatorMutationError,
      BackupPolicyUpdateVariables
    >,
    'mutationFn'
  > = {}
) => {
  const queryClient = useQueryClient()
  return useMutation({
    ...options,
    mutationFn: async ({ projectRef, payload }) =>
      backupPolicySchema.parse(await mutateOperator(projectRef, 'policy', 'PUT', payload)),
    async onSuccess(data, variables, context) {
      await queryClient.invalidateQueries({
        queryKey: backupOperatorKeys.policy(variables.projectRef),
      })
      await options.onSuccess?.(data, variables, context)
    },
    onError(error, variables, context) {
      if (options.onError) options.onError(error, variables, context)
      else
        toast.error($t('Failed to update backup policy: {{message}}', { message: error.message }))
    },
  })
}

export type RestorePlanCreateVariables = { projectRef: string; recoveryTarget: string }
export const useRestorePlanCreateMutation = (
  options: Omit<
    UseMutationOptions<
      ReturnType<typeof restorePlanSchema.parse>,
      OperatorMutationError,
      RestorePlanCreateVariables
    >,
    'mutationFn'
  > = {}
) => {
  const queryClient = useQueryClient()
  return useMutation({
    ...options,
    mutationFn: async ({ projectRef, recoveryTarget }) =>
      restorePlanSchema.parse(
        await mutateOperator(projectRef, 'restore-plans', 'POST', { recoveryTarget })
      ),
    async onSuccess(data, variables, context) {
      queryClient.setQueryData(backupOperatorKeys.plan(variables.projectRef, data.id), data)
      await options.onSuccess?.(data, variables, context)
    },
    onError(error, variables, context) {
      if (options.onError) options.onError(error, variables, context)
      else toast.error($t('Failed to create restore plan: {{message}}', { message: error.message }))
    },
  })
}

export type RestoreActionVariables = {
  projectRef: string
  planId: string
  planHash: string
}
export const useRestoreExecuteMutation = (
  options: Omit<
    UseMutationOptions<
      ReturnType<typeof operatorJobSchema.parse>,
      OperatorMutationError,
      RestoreActionVariables
    >,
    'mutationFn'
  > = {}
) =>
  useMutation({
    ...options,
    mutationFn: async ({ projectRef, planId, planHash }) => {
      await mutateOperator(projectRef, `restore-plans/${planId}/confirm`, 'POST', { planHash })
      return operatorJobSchema.parse(
        await mutateOperator(projectRef, `restore-plans/${planId}/execute`, 'POST', { planHash })
      )
    },
    onError(error, variables, context) {
      if (options.onError) options.onError(error, variables, context)
      else toast.error($t('Failed to start restore: {{message}}', { message: error.message }))
    },
  })

export type RestoreRollbackVariables = { projectRef: string; jobId: string }
export const useRestoreRollbackMutation = (
  options: Omit<
    UseMutationOptions<
      ReturnType<typeof operatorJobSchema.parse>,
      OperatorMutationError,
      RestoreRollbackVariables
    >,
    'mutationFn'
  > = {}
) =>
  useMutation({
    ...options,
    mutationFn: async ({ projectRef, jobId }) =>
      operatorJobSchema.parse(
        await mutateOperator(projectRef, `jobs/${jobId}/rollback`, 'POST', {})
      ),
    onError(error, variables, context) {
      if (options.onError) options.onError(error, variables, context)
      else toast.error($t('Failed to start rollback: {{message}}', { message: error.message }))
    },
  })
