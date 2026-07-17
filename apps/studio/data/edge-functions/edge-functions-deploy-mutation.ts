import { useMutation, useQueryClient } from '@tanstack/react-query'
import { components } from 'api-types'
import { toast } from 'sonner'
import { z } from 'zod'

import { edgeFunctionsKeys } from './keys'
import {
  getFallbackEntrypointPath,
  getFallbackImportMapPath,
  getStaticPatterns,
} from '@/components/interfaces/EdgeFunctions/EdgeFunctions.utils'
import { constructHeaders, handleError, post } from '@/data/fetchers'
import { STUDIO_DEPLOYMENT_PROFILE } from '@/lib/constants/deployment-profile'
import { uuidv4 } from '@/lib/helpers'
import { ResponseError, type UseCustomMutationOptions } from '@/types'

type EdgeFunctionsDeployBodyMetadata = components['schemas']['FunctionDeployBody']['metadata']
type EdgeFunctionsDeployVariables = {
  projectRef: string
  slug: string
  metadata: Partial<EdgeFunctionsDeployBodyMetadata>
  files: { name: string; content: string }[]
  authorization?: string
  expectedGeneration?: number
}

export async function deployEdgeFunction({
  projectRef,
  slug,
  metadata: _metadata,
  files,
  authorization,
  expectedGeneration = 0,
}: EdgeFunctionsDeployVariables) {
  if (!projectRef) throw new Error('projectRef is required')

  // [Joshen] Consolidating this logic in the RQ since these values need to be set if they're not
  // provided from the callee, and their fallback values depends on the files provided
  const metadata = { ..._metadata }
  if (!_metadata.entrypoint_path) metadata.entrypoint_path = getFallbackEntrypointPath(files)
  if (!_metadata.import_map_path) metadata.import_map_path = getFallbackImportMapPath(files)
  if (!_metadata.static_patterns) metadata.static_patterns = getStaticPatterns(files)

  if (STUDIO_DEPLOYMENT_PROFILE === 'fleet') {
    const idempotencyKey = uuidv4()
    const response = await fetch(
      `/api/platform/fleet/v1/projects/${encodeURIComponent(projectRef)}/functions`,
      {
        method: 'POST',
        headers: await constructHeaders({
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
        }),
        body: JSON.stringify({
          slug,
          expectedGeneration,
          metadata: {
            entrypointPath: metadata.entrypoint_path,
            importMapPath: metadata.import_map_path,
            staticPatterns: metadata.static_patterns ?? [],
            verifyJwt: metadata.verify_jwt ?? true,
          },
          files,
        }),
      }
    )
    const text = await response.text()
    let body: unknown
    try {
      body = text === '' ? {} : JSON.parse(text)
    } catch {
      throw new ResponseError('Function deployment API returned invalid JSON', response.status)
    }
    if (!response.ok) {
      const message =
        body !== null &&
        typeof body === 'object' &&
        'message' in body &&
        typeof body.message === 'string'
          ? body.message
          : 'Failed to deploy edge function'
      throw new ResponseError(message, response.status)
    }
    return z
      .object({
        deployment: z.object({ slug: z.string(), generation: z.number().int() }).passthrough(),
      })
      .parse(body)
  }

  const { data, error } = await post(`/v1/projects/{ref}/functions/deploy`, {
    params: { path: { ref: projectRef }, query: { slug: slug } },
    ...(authorization && { headers: { Authorization: authorization } }),
    body: {
      file: files as any,
      metadata: metadata as EdgeFunctionsDeployBodyMetadata,
    },
    bodySerializer(body) {
      const formData = new FormData()

      formData.append('metadata', JSON.stringify(body.metadata))

      body?.file?.forEach((f: any) => {
        const file = f as { name: string; content: string }
        const blob = new Blob([file.content], { type: 'text/plain' })
        formData.append('file', blob, file.name)
      })

      return formData
    },
  })

  if (error) handleError(error)
  return data
}

type EdgeFunctionsDeployData = Awaited<ReturnType<typeof deployEdgeFunction>>

export const useEdgeFunctionDeployMutation = ({
  onSuccess,
  onError,
  ...options
}: Omit<
  UseCustomMutationOptions<EdgeFunctionsDeployData, ResponseError, EdgeFunctionsDeployVariables>,
  'mutationFn'
> = {}) => {
  const queryClient = useQueryClient()

  return useMutation<EdgeFunctionsDeployData, ResponseError, EdgeFunctionsDeployVariables>({
    mutationFn: (vars) => deployEdgeFunction(vars),
    async onSuccess(data, variables, context) {
      const { projectRef, slug } = variables
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: edgeFunctionsKeys.list(projectRef) }),
        queryClient.invalidateQueries({ queryKey: edgeFunctionsKeys.detail(projectRef, slug) }),
        queryClient.invalidateQueries({ queryKey: edgeFunctionsKeys.body(projectRef, slug) }),
        queryClient.invalidateQueries({ queryKey: edgeFunctionsKeys.deployments(projectRef) }),
      ])
      await onSuccess?.(data, variables, context)
    },
    async onError(data, variables, context) {
      if (onError === undefined) {
        toast.error(`Failed to deploy edge function: ${data.message}`)
      } else {
        onError(data, variables, context)
      }
    },
    ...options,
  })
}
