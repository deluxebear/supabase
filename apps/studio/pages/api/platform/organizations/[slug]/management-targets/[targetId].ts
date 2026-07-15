import { randomUUID } from 'node:crypto'
import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import type { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import {
  getManagementTarget,
  ManagementTrustConflict,
  revokeManagementTarget,
} from '@/lib/api/self-platform/management-trust'
import { guardOrgRoute } from '@/lib/api/self-platform/rbac/enforce'
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
  if (Array.isArray(req.query.slug) || Array.isArray(req.query.targetId)) {
    return res.status(400).json({ code: 'validation_failed', message: 'Invalid route parameter' })
  }
  const slug = String(req.query.slug)
  const targetId = String(req.query.targetId)
  const action = req.method === 'GET' ? PermissionAction.READ : PermissionAction.UPDATE
  const organization = await guardOrgRoute(res, claims, {
    slug,
    action,
    resource: 'organizations',
  })
  if (!organization) return

  if (req.method === 'GET') {
    const target = await getManagementTarget(organization.orgId, targetId)
    return target
      ? res.status(200).json(target)
      : res
          .status(404)
          .json({ code: 'management_target_not_found', message: 'Management target not found' })
  }
  if (req.method === 'DELETE') {
    try {
      await revokeManagementTarget({
        organizationId: organization.orgId,
        targetId,
        actor: claims?.sub ?? 'unknown',
        correlationId:
          (typeof req.headers['x-correlation-id'] === 'string' &&
            req.headers['x-correlation-id']) ||
          randomUUID(),
      })
      return res.status(200).json({ id: targetId, state: 'revoked' })
    } catch (error) {
      if (error instanceof ManagementTrustConflict) {
        return res.status(409).json({ code: error.code, message: error.message })
      }
      throw error
    }
  }
  res.setHeader('Allow', ['GET', 'DELETE'])
  return res.status(405).json({ code: 'validation_failed', message: 'Method not allowed' })
}
