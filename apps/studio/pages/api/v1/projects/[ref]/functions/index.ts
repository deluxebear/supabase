import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import type { components } from 'api-types'
import { type NextApiRequest, type NextApiResponse } from 'next'

import { apiWrapper } from '@/lib/api/apiWrapper'
import { getFunctionsArtifactStore } from '@/lib/api/self-hosted/functions'
import { requireProjectCapability } from '@/lib/api/self-platform/attachment'
import { listFunctionDeployments } from '@/lib/api/self-platform/function-deployments'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { STUDIO_DEPLOYMENT_PROFILE } from '@/lib/constants/deployment-profile'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'
import { uuidv4 } from '@/lib/helpers'

export default function handlerWithErrorCatching(req: NextApiRequest, res: NextApiResponse) {
  return apiWrapper(req, res, handler, { withAuth: true })
}

// [self-platform] exported for handler-level tests
export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  const { method } = req

  // [self-platform] M3.1 RBAC guard (M3.0 final-review I2 first batch).
  // 404-before-403 lives inside guardProjectRoute (resolver-first). Note the
  // Embedded keeps the upstream mounted directory contract. Fleet branches to
  // the project-scoped platform deployment authority below.
  if (IS_SELF_PLATFORM && method === 'GET') {
    const ok = await guardProjectRoute(res, claims, {
      action: PermissionAction.FUNCTIONS_READ,
      projectRef: String(req.query.ref),
    })
    if (!ok) return
  }

  switch (method) {
    case 'GET':
      if (STUDIO_DEPLOYMENT_PROFILE === 'fleet') {
        return handleFleetGetAll(String(req.query.ref), res)
      }
      return handleGetAll(req, res)
    default:
      res.setHeader('Allow', ['GET'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

const handleFleetGetAll = async (projectRef: string, res: NextApiResponse) => {
  await requireProjectCapability(projectRef, 'functions.read')
  const deployments = await listFunctionDeployments(projectRef)
  return res.status(200).json(
    deployments.map(
      (deployment) =>
        ({
          id: `${deployment.projectRef}:${deployment.slug}`,
          slug: deployment.slug,
          version: deployment.generation,
          name: deployment.slug,
          status: 'ACTIVE',
          created_at: Date.parse(deployment.createdAt),
          updated_at: Date.parse(deployment.updatedAt),
        }) satisfies EdgeFunctionsResponse
    )
  )
}

type EdgeFunctionsResponse = components['schemas']['FunctionResponse_Output']

const handleGetAll = async (_req: NextApiRequest, res: NextApiResponse) => {
  const store = getFunctionsArtifactStore()

  const functionsArtifacts = await store.getFunctions()
  if (functionsArtifacts.length === 0) return res.status(200).json([])

  const functions = functionsArtifacts.map(
    (func) =>
      ({
        id: uuidv4(),
        slug: func.slug,
        version: 1,
        name: func.slug,
        status: 'ACTIVE',
        entrypoint_path: func.entrypoint_path,
        created_at: func.created_at,
        updated_at: func.updated_at,
      }) satisfies EdgeFunctionsResponse
  )

  return res.status(200).json(functions)
}
