import { randomUUID } from 'node:crypto'
import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import type { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import {
  createManagementTarget,
  listManagementTargets,
  managementTargetInputSchema,
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
  if (Array.isArray(req.query.slug)) {
    return res.status(400).json({ code: 'validation_failed', message: 'Invalid slug parameter' })
  }
  const slug = String(req.query.slug)
  if (req.method === 'GET') {
    const organization = await guardOrgRoute(res, claims, {
      slug,
      action: PermissionAction.READ,
      resource: 'organizations',
    })
    if (!organization) return
    return res.status(200).json({ targets: await listManagementTargets(organization.orgId) })
  }
  if (req.method === 'POST') {
    const parsed = managementTargetInputSchema.safeParse(req.body)
    if (!parsed.success) {
      return res.status(400).json({
        code: 'validation_failed',
        message: 'Management target input is invalid',
        details: parsed.error.flatten(),
      })
    }
    const organization = await guardOrgRoute(res, claims, {
      slug,
      action: PermissionAction.UPDATE,
      resource: 'organizations',
    })
    if (!organization) return
    const target = await createManagementTarget({
      organizationId: organization.orgId,
      target: parsed.data,
      actor: claims?.sub ?? 'unknown',
      correlationId:
        (typeof req.headers['x-correlation-id'] === 'string' && req.headers['x-correlation-id']) ||
        randomUUID(),
    })
    return res.status(201).json(target)
  }
  res.setHeader('Allow', ['GET', 'POST'])
  return res.status(405).json({ code: 'validation_failed', message: 'Method not allowed' })
}
