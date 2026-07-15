import { randomUUID } from 'node:crypto'
import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import type { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { CapabilityUnavailable } from '@/lib/api/self-platform/attachment'
import {
  createLifecycleImpactPlan,
  executeLifecyclePlan,
  getLifecycleGeneration,
  LifecycleConflict,
  lifecycleExecuteInputSchema,
  lifecyclePlanInputSchema,
} from '@/lib/api/self-platform/lifecycle'
import { ManagementTrustDownstreamError } from '@/lib/api/self-platform/management-trust'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { STUDIO_CAPABILITIES, STUDIO_DEPLOYMENT_PROFILE } from '@/lib/constants/deployment-profile'

function isAvailable() {
  return STUDIO_DEPLOYMENT_PROFILE === 'fleet' && STUDIO_CAPABILITIES.lifecycleManagement
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
  if (Array.isArray(req.query.ref))
    return res.status(400).json({ code: 'validation_failed', message: 'Invalid ref parameter' })
  const projectRef = String(req.query.ref)
  const allowed = await guardProjectRoute(res, claims, {
    action: PermissionAction.UPDATE,
    projectRef,
    resource: 'projects',
  })
  if (!allowed) return
  const correlationId =
    (typeof req.headers['x-correlation-id'] === 'string' && req.headers['x-correlation-id']) ||
    randomUUID()
  const actor = claims?.sub ?? 'unknown'
  try {
    if (req.body?.phase === 'plan') {
      const parsed = lifecyclePlanInputSchema.safeParse(req.body.input)
      if (!parsed.success)
        return res
          .status(400)
          .json({
            code: 'validation_failed',
            message: 'Lifecycle plan input is invalid',
            details: parsed.error.flatten(),
          })
      const [plan, expectedGeneration] = await Promise.all([
        createLifecycleImpactPlan({ projectRef, value: parsed.data, actor, correlationId }),
        getLifecycleGeneration(projectRef, parsed.data.action),
      ])
      return res.status(201).json({ plan, expectedGeneration })
    }
    if (req.body?.phase === 'execute') {
      const idempotencyKey = req.headers['idempotency-key']
      const parsed = lifecycleExecuteInputSchema.safeParse({ ...req.body.input, idempotencyKey })
      if (!parsed.success)
        return res
          .status(400)
          .json({
            code: 'validation_failed',
            message: 'Lifecycle execution input is invalid',
            details: parsed.error.flatten(),
          })
      if (
        parsed.data.plan.requiresRecentAal2 &&
        (claims?.aal !== 'aal2' ||
          typeof claims.iat !== 'number' ||
          Date.now() / 1000 - claims.iat > 600)
      )
        return res
          .status(403)
          .json({
            code: 'aal2_required',
            message: 'A recent AAL2 session is required for this lifecycle action',
          })
      return res
        .status(202)
        .json({
          operation: await executeLifecyclePlan({
            projectRef,
            value: parsed.data,
            actor,
            correlationId,
            aal: claims?.aal,
            aalAuthenticatedAt: claims?.iat,
          }),
        })
    }
    return res
      .status(400)
      .json({ code: 'validation_failed', message: 'Lifecycle request phase is invalid' })
  } catch (error) {
    if (error instanceof CapabilityUnavailable)
      return res
        .status(409)
        .json({ code: 'capability_unavailable', message: error.message, blockers: error.blockers })
    if (error instanceof LifecycleConflict)
      return res.status(409).json({ code: error.code, message: error.message })
    if (error instanceof ManagementTrustDownstreamError)
      return res.status(error.status).json({ code: error.code, message: error.message })
    throw error
  }
}
