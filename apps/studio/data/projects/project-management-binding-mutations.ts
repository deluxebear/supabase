import { useMutation, useQueryClient, type UseMutationOptions } from '@tanstack/react-query'
import { toast } from 'sonner'
import { z } from 'zod'

import { projectKeys } from './keys'
import { del, handleError, post, put } from '@/data/fetchers'
import {
  enrollmentTokenResponseSchema,
  managementBindingResponseSchema,
  type EnrollmentTokenResponse,
  type ManagementBindingPayload,
  type ManagementBindingResponse,
} from '@/data/management-trust/types'
import type { ResponseError } from '@/types'

const bindingEnvelopeSchema = z.object({ binding: managementBindingResponseSchema })

export type ProjectManagementBindVariables = {
  projectRef: string
  payload: ManagementBindingPayload
}

async function bindProjectManagementTarget({
  projectRef,
  payload,
}: ProjectManagementBindVariables) {
  const { data, error } = await put(
    '/platform/projects/{ref}/management-binding' as never,
    { params: { path: { ref: projectRef } }, body: payload } as never
  )
  if (error) handleError(error)
  return bindingEnvelopeSchema.parse(data).binding
}

export type ProjectEnrollmentTokenVariables = { projectRef: string }

async function issueProjectEnrollmentToken({ projectRef }: ProjectEnrollmentTokenVariables) {
  const { data, error } = await post(
    '/platform/projects/{ref}/management-binding/enrollment-token' as never,
    { params: { path: { ref: projectRef } } } as never
  )
  if (error) handleError(error)
  return enrollmentTokenResponseSchema.parse(data)
}

export type ProjectManagementSyncVariables = { projectRef: string }

async function syncProjectManagementBinding({ projectRef }: ProjectManagementSyncVariables) {
  const { data, error } = await post(
    '/platform/projects/{ref}/management-binding/sync' as never,
    { params: { path: { ref: projectRef } } } as never
  )
  if (error) handleError(error)
  return bindingEnvelopeSchema.parse(data).binding
}

export type ProjectManagementRevokeVariables = { projectRef: string }
export type ProjectManagementRevokeData = {
  bindingId: string
  targetRevoked: boolean
  targetCleanupPending: boolean
}

async function revokeProjectManagementBinding({ projectRef }: ProjectManagementRevokeVariables) {
  const { data, error } = await del(
    '/platform/projects/{ref}/management-binding' as never,
    { params: { path: { ref: projectRef } } } as never
  )
  if (error) handleError(error)
  return data as unknown as ProjectManagementRevokeData
}

function useInvalidateManagementBinding() {
  const queryClient = useQueryClient()
  return async (projectRef: string) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: projectKeys.managementBinding(projectRef) }),
      queryClient.invalidateQueries({ queryKey: projectKeys.detail(projectRef) }),
    ])
  }
}

export const useProjectManagementBindMutation = ({
  onSuccess,
  onError,
  ...options
}: Omit<
  UseMutationOptions<ManagementBindingResponse, ResponseError, ProjectManagementBindVariables>,
  'mutationFn'
> = {}) => {
  const invalidate = useInvalidateManagementBinding()
  return useMutation({
    mutationFn: bindProjectManagementTarget,
    async onSuccess(data, variables, context) {
      await invalidate(variables.projectRef)
      await onSuccess?.(data, variables, context)
    },
    async onError(error, variables, context) {
      if (onError === undefined) toast.error(`Failed to bind management target: ${error.message}`)
      else await onError(error, variables, context)
    },
    ...options,
  })
}

export const useProjectEnrollmentTokenMutation = ({
  onSuccess,
  onError,
  ...options
}: Omit<
  UseMutationOptions<EnrollmentTokenResponse, ResponseError, ProjectEnrollmentTokenVariables>,
  'mutationFn'
> = {}) => {
  const invalidate = useInvalidateManagementBinding()
  return useMutation({
    mutationFn: issueProjectEnrollmentToken,
    async onSuccess(data, variables, context) {
      await invalidate(variables.projectRef)
      await onSuccess?.(data, variables, context)
    },
    async onError(error, variables, context) {
      if (onError === undefined) toast.error(`Failed to issue enrollment token: ${error.message}`)
      else await onError(error, variables, context)
    },
    ...options,
  })
}

export const useProjectManagementSyncMutation = ({
  onSuccess,
  onError,
  ...options
}: Omit<
  UseMutationOptions<ManagementBindingResponse, ResponseError, ProjectManagementSyncVariables>,
  'mutationFn'
> = {}) => {
  const invalidate = useInvalidateManagementBinding()
  return useMutation({
    mutationFn: syncProjectManagementBinding,
    async onSuccess(data, variables, context) {
      await invalidate(variables.projectRef)
      await onSuccess?.(data, variables, context)
    },
    async onError(error, variables, context) {
      if (onError === undefined) toast.error(`Failed to refresh Agent trust: ${error.message}`)
      else await onError(error, variables, context)
    },
    ...options,
  })
}

export const useProjectManagementRevokeMutation = ({
  onSuccess,
  onError,
  ...options
}: Omit<
  UseMutationOptions<ProjectManagementRevokeData, ResponseError, ProjectManagementRevokeVariables>,
  'mutationFn'
> = {}) => {
  const invalidate = useInvalidateManagementBinding()
  return useMutation({
    mutationFn: revokeProjectManagementBinding,
    async onSuccess(data, variables, context) {
      await invalidate(variables.projectRef)
      await onSuccess?.(data, variables, context)
    },
    async onError(error, variables, context) {
      if (onError === undefined) toast.error(`Failed to revoke Agent trust: ${error.message}`)
      else await onError(error, variables, context)
    },
    ...options,
  })
}
