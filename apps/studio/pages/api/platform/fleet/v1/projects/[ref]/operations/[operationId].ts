import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import type { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { getOperationSummary } from '@/lib/api/self-platform/desired-state'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { STUDIO_CAPABILITIES, STUDIO_DEPLOYMENT_PROFILE } from '@/lib/constants/deployment-profile'

export default function route(req: NextApiRequest, res: NextApiResponse) {
  // Keep the Fleet-only path indistinguishable from a missing upstream route
  // before authentication or any platform lookup in Embedded Studio.
  if (STUDIO_DEPLOYMENT_PROFILE !== 'fleet' || !STUDIO_CAPABILITIES.platformIdentity) {
    return res.status(404).json({ code: 'project_not_found', message: 'Not found' })
  }
  return apiWrapper(req, res, handler, { withAuth: true })
}

export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  if (STUDIO_DEPLOYMENT_PROFILE !== 'fleet' || !STUDIO_CAPABILITIES.platformIdentity) {
    return res.status(404).json({ code: 'project_not_found', message: 'Not found' })
  }
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res.status(405).json({ code: 'validation_failed', message: 'Method not allowed' })
  }
  const projectRef = String(req.query.ref)
  const operationId = String(req.query.operationId)
  const isAllowed = await guardProjectRoute(res, claims, {
    action: PermissionAction.READ,
    projectRef,
  })
  if (!isAllowed) return

  const operation = await getOperationSummary(projectRef, operationId)
  if (!operation) {
    return res.status(404).json({
      code: 'project_not_found',
      message: 'Operation was not found in this project',
    })
  }
  res.setHeader('Cache-Control', 'no-store')
  return res.status(200).json(operation)
}
