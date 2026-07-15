import { randomUUID } from 'node:crypto'
import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import type { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { CapabilityUnavailable, requireProjectCapability } from '@/lib/api/self-platform/attachment'
import {
  issueProjectEnrollmentToken,
  ManagementTrustConflict,
  ManagementTrustDownstreamError,
} from '@/lib/api/self-platform/management-trust'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { STUDIO_CAPABILITIES, STUDIO_DEPLOYMENT_PROFILE } from '@/lib/constants/deployment-profile'

function isAvailable() {
  return STUDIO_DEPLOYMENT_PROFILE === 'fleet' && STUDIO_CAPABILITIES.managementTrust
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
    action: PermissionAction.UPDATE,
    projectRef,
    resource: 'projects',
  })
  if (!allowed) return
  try {
    await requireProjectCapability(projectRef, 'management.enrollment.issue')
    res.setHeader('Cache-Control', 'no-store')
    return res.status(201).json(
      await issueProjectEnrollmentToken({
        projectRef,
        actor: claims?.sub ?? 'unknown',
        correlationId:
          (typeof req.headers['x-correlation-id'] === 'string' &&
            req.headers['x-correlation-id']) ||
          randomUUID(),
      })
    )
  } catch (error) {
    if (error instanceof CapabilityUnavailable) {
      return res
        .status(409)
        .json({ code: 'capability_unavailable', message: error.message, blockers: error.blockers })
    }
    if (error instanceof ManagementTrustConflict) {
      return res.status(409).json({ code: error.code, message: error.message })
    }
    if (error instanceof ManagementTrustDownstreamError) {
      return res.status(error.status >= 400 && error.status < 600 ? error.status : 502).json({
        code: error.code,
        message: error.message,
        details: error.details,
      })
    }
    throw error
  }
}
