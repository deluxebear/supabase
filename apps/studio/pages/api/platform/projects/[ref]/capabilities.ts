import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import type { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { listProjectCapabilities } from '@/lib/api/self-platform/attachment'
import {
  ManagementTrustConflict,
  ManagementTrustDownstreamError,
  syncProjectManagementBinding,
} from '@/lib/api/self-platform/management-trust'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { STUDIO_CAPABILITIES, STUDIO_DEPLOYMENT_PROFILE } from '@/lib/constants/deployment-profile'

export default function route(req: NextApiRequest, res: NextApiResponse) {
  if (STUDIO_DEPLOYMENT_PROFILE !== 'fleet' || !STUDIO_CAPABILITIES.projectAttachment) {
    return res.status(404).json({ code: 'project_not_found', message: 'Not found' })
  }
  return apiWrapper(req, res, handler, { withAuth: true })
}

export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res.status(405).json({ code: 'validation_failed', message: 'Method not allowed' })
  }
  if (Array.isArray(req.query.ref)) {
    return res.status(400).json({ code: 'validation_failed', message: 'Invalid ref parameter' })
  }
  const projectRef = String(req.query.ref)
  const allowed = await guardProjectRoute(res, claims, {
    action: PermissionAction.READ,
    projectRef,
    resource: 'projects',
  })
  if (!allowed) return
  try {
    await syncProjectManagementBinding({
      projectRef,
      actor: claims?.sub ?? 'unknown',
    })
  } catch (error) {
    if (
      !(error instanceof ManagementTrustConflict) &&
      !(error instanceof ManagementTrustDownstreamError)
    ) {
      throw error
    }
  }
  return res.status(200).json({ capabilities: await listProjectCapabilities(projectRef) })
}
