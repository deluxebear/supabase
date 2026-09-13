import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import type { components } from 'api-types'
import { type NextApiRequest, type NextApiResponse } from 'next'

import { apiWrapper } from '@/lib/api/apiWrapper'
import { getFunctionsArtifactStore } from '@/lib/api/self-hosted/functions'
import { requireProjectCapability } from '@/lib/api/self-platform/attachment'
import { getFunctionDeployment } from '@/lib/api/self-platform/function-deployments'
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
        return handleFleetGet(req, res)
      }
      return handleGet(req, res)
    default:
      res.setHeader('Allow', ['GET'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

const handleFleetGet = async (req: NextApiRequest, res: NextApiResponse) => {
  const slugParam = req.query.slug
  const slug = Array.isArray(slugParam) ? slugParam[0] : slugParam
  if (!slug) return res.status(404).json({ error: { message: `Function not found` } })
  const projectRef = String(req.query.ref)
  await requireProjectCapability(projectRef, 'functions.read')
  const deployment = await getFunctionDeployment(projectRef, slug)
  if (!deployment || deployment.state === 'deleted') {
    return res.status(404).json({ error: { message: `Function not found` } })
  }
  return res.status(200).json({
    id: `${deployment.projectRef}:${deployment.slug}`,
    slug: deployment.slug,
    version: deployment.generation,
    name: deployment.slug,
    status: 'ACTIVE',
    created_at: Date.parse(deployment.createdAt),
    updated_at: Date.parse(deployment.updatedAt),
  } satisfies EdgeFunctionsResponse)
}

type EdgeFunctionsResponse = components['schemas']['FunctionResponse_Output']

const handleGet = async (req: NextApiRequest, res: NextApiResponse) => {
  const slugParam = req.query.slug
  const slug = Array.isArray(slugParam) ? slugParam[0] : slugParam
  if (!slug)
    return res.status(404).json({ error: { message: `Missing function 'slug' parameter` } })

  const store = getFunctionsArtifactStore()

  const functionsArtifact = await store.getFunctionBySlug(slug)
  if (!functionsArtifact) return res.status(404).json({ error: { message: `Function not found` } })

  const functionResponse = {
    id: uuidv4(),
    slug: functionsArtifact.slug,
    version: 1,
    name: functionsArtifact.slug,
    status: 'ACTIVE',
    entrypoint_path: functionsArtifact.entrypoint_path,
    created_at: functionsArtifact.created_at,
    updated_at: functionsArtifact.updated_at,
  } satisfies EdgeFunctionsResponse

  return res.status(200).json(functionResponse)
}
