import { randomUUID } from 'crypto'
import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import type { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { cancelFleetOperation } from '@/lib/api/self-platform/fleet-operations'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { STUDIO_CAPABILITIES, STUDIO_DEPLOYMENT_PROFILE } from '@/lib/constants/deployment-profile'

export default function route(req: NextApiRequest, res: NextApiResponse) {
  if (STUDIO_DEPLOYMENT_PROFILE !== 'fleet' || !STUDIO_CAPABILITIES.platformIdentity) {
    return res.status(404).json({ code: 'project_not_found', message: 'Not found' })
  }
  return apiWrapper(req, res, handler, { withAuth: true })
}

export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST'])
    return res.status(405).json({ code: 'validation_failed', message: 'Method not allowed' })
  }
  const projectRef = String(req.query.ref)
  const operationId = String(req.query.operationId)
  if (!(await guardProjectRoute(res, claims, { action: PermissionAction.UPDATE, projectRef })))
    return
  const operation = await cancelFleetOperation({
    projectRef,
    operationId,
    actor: claims?.sub ?? 'unknown',
    correlationId: String(req.headers['x-correlation-id'] ?? randomUUID()),
  })
  res.setHeader('Cache-Control', 'no-store')
  return res.status(200).json(operation)
}
