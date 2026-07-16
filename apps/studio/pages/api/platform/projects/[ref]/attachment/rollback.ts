import { randomUUID } from 'node:crypto'
import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import type { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import {
  CapabilityUnavailable,
  requireProjectCapability,
  rollbackStagedAttachment,
} from '@/lib/api/self-platform/attachment'
import {
  getProjectManagementBinding,
  revokeProjectManagementBinding,
} from '@/lib/api/self-platform/management-trust'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { STUDIO_CAPABILITIES, STUDIO_DEPLOYMENT_PROFILE } from '@/lib/constants/deployment-profile'

function isAvailable() {
  return STUDIO_DEPLOYMENT_PROFILE === 'fleet' && STUDIO_CAPABILITIES.projectAttachment
}

export default function route(req: NextApiRequest, res: NextApiResponse) {
  if (!isAvailable())
    return res.status(404).json({ code: 'project_not_found', message: 'Not found' })
  return apiWrapper(req, res, handler, { withAuth: true })
}

export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  if (!isAvailable())
    return res.status(404).json({ code: 'project_not_found', message: 'Not found' })
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST'])
    return res.status(405).json({ code: 'validation_failed', message: 'Method not allowed' })
  }
  if (Array.isArray(req.query.ref)) {
    return res.status(400).json({ code: 'validation_failed', message: 'Invalid ref parameter' })
  }
  const projectRef = String(req.query.ref)
  const allowed = await guardProjectRoute(res, claims, {
    action: PermissionAction.DELETE,
    projectRef,
    resource: 'projects',
  })
  if (!allowed) return

  try {
    await requireProjectCapability(projectRef, 'project.detach')
    const actor = claims?.sub ?? 'unknown'
    const correlationId =
      (typeof req.headers['x-correlation-id'] === 'string' && req.headers['x-correlation-id']) ||
      randomUUID()
    if (await getProjectManagementBinding(projectRef)) {
      await revokeProjectManagementBinding({ projectRef, actor, correlationId })
    }
    return res.status(200).json(
      await rollbackStagedAttachment({
        projectRef,
        actor,
        correlationId,
      })
    )
  } catch (error) {
    if (error instanceof CapabilityUnavailable) {
      return res.status(409).json({
        code: 'capability_unavailable',
        message: error.message,
        blockers: error.blockers,
      })
    }
    throw error
  }
}
