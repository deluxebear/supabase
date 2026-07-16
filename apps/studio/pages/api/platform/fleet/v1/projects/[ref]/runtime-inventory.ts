import { randomUUID } from 'node:crypto'
import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import type { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { CapabilityUnavailable } from '@/lib/api/self-platform/attachment'
import { ManagementTrustDownstreamError } from '@/lib/api/self-platform/management-trust'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { getRuntimeInventory } from '@/lib/api/self-platform/runtime-inventory'
import { STUDIO_DEPLOYMENT_PROFILE } from '@/lib/constants/deployment-profile'

export default function route(req: NextApiRequest, res: NextApiResponse) {
  if (STUDIO_DEPLOYMENT_PROFILE !== 'fleet')
    return res.status(404).json({ code: 'project_not_found', message: 'Not found' })
  return apiWrapper(req, res, handler, { withAuth: true })
}

export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  if (STUDIO_DEPLOYMENT_PROFILE !== 'fleet')
    return res.status(404).json({ code: 'project_not_found', message: 'Not found' })
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res.status(405).json({ code: 'validation_failed', message: 'Method not allowed' })
  }
  if (Array.isArray(req.query.ref))
    return res.status(400).json({ code: 'validation_failed', message: 'Invalid ref parameter' })
  const projectRef = String(req.query.ref)
  const allowed = await guardProjectRoute(res, claims, {
    action: PermissionAction.READ,
    projectRef,
    resource: 'projects',
  })
  if (!allowed) return
  const correlationId =
    (typeof req.headers['x-correlation-id'] === 'string' && req.headers['x-correlation-id']) ||
    randomUUID()
  try {
    const inventory = await getRuntimeInventory({
      projectRef,
      actor: claims?.sub ?? 'unknown',
      correlationId,
      force: req.query.refresh === 'true',
    })
    return res.status(200).json({ inventory })
  } catch (error) {
    if (error instanceof CapabilityUnavailable)
      return res
        .status(409)
        .json({ code: 'capability_unavailable', message: error.message, blockers: error.blockers })
    if (error instanceof ManagementTrustDownstreamError)
      return res.status(error.status).json({ code: error.code, message: error.message })
    throw error
  }
}
