import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import type { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { buildFleetConnectionProfiles } from '@/lib/api/self-platform/connection-profiles'
import {
  EndpointRegistryMissing,
  requireProjectEndpointRegistry,
} from '@/lib/api/self-platform/endpoint-registry'
import { getProjectByRef } from '@/lib/api/self-platform/projects'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { STUDIO_DEPLOYMENT_PROFILE } from '@/lib/constants/deployment-profile'

export default function route(req: NextApiRequest, res: NextApiResponse) {
  if (STUDIO_DEPLOYMENT_PROFILE !== 'fleet') return res.status(404).json({ message: 'Not found' })
  return apiWrapper(req, res, handler, { withAuth: true })
}

export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  if (STUDIO_DEPLOYMENT_PROFILE !== 'fleet') return res.status(404).json({ message: 'Not found' })
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res.status(405).json({ message: 'Method not allowed' })
  }
  if (Array.isArray(req.query.ref)) {
    return res.status(400).json({ message: 'Invalid ref parameter' })
  }
  const projectRef = String(req.query.ref)
  const allowed = await guardProjectRoute(res, claims, {
    action: PermissionAction.READ,
    projectRef,
    resource: 'projects',
  })
  if (!allowed) return
  try {
    const [registry, project] = await Promise.all([
      requireProjectEndpointRegistry(projectRef),
      getProjectByRef(projectRef),
    ])
    if (!project) return res.status(404).json({ message: 'Project not found' })
    res.setHeader('Cache-Control', 'no-store')
    return res.status(200).json({
      revision: registry.revision,
      profiles: buildFleetConnectionProfiles(registry.endpoints, project.db_user_readonly),
    })
  } catch (error) {
    if (error instanceof EndpointRegistryMissing) {
      return res.status(409).json({
        code: 'endpoint_registry_unconfigured',
        message: error.message,
      })
    }
    throw error
  }
}
