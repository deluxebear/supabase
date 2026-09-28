// [self-platform] Phase 2: apply stored Auth settings to the project's Auth
// service. GET reports whether the running service uses the stored settings;
// POST commits them as the desired revision, which the Fleet Agent writes and
// rolls out. Fleet profile only.
import { randomUUID } from 'node:crypto'
import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import type { NextApiRequest, NextApiResponse } from 'next'
import { z } from 'zod'

import apiWrapper from '@/lib/api/apiWrapper'
import { CapabilityUnavailable } from '@/lib/api/self-platform/attachment'
import {
  applyAuthConfig,
  AuthApplyConflict,
  getAuthApplyStatus,
} from '@/lib/api/self-platform/auth-apply'
import {
  CapacityExceededError,
  ConfigurationConflictError,
} from '@/lib/api/self-platform/desired-state'
import { OwnershipPolicyConflict } from '@/lib/api/self-platform/ownership-policy'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { STUDIO_DEPLOYMENT_PROFILE } from '@/lib/constants/deployment-profile'

const RECENT_AAL2_SECONDS = 600

const applyBodySchema = z
  .object({
    expectedGeneration: z.number().int().nonnegative(),
    confirmOwnership: z.boolean().default(false),
  })
  .strict()

const isAvailable = () => STUDIO_DEPLOYMENT_PROFILE === 'fleet'

export default function route(req: NextApiRequest, res: NextApiResponse) {
  if (!isAvailable())
    return res.status(404).json({ code: 'project_not_found', message: 'Not found' })
  return apiWrapper(req, res, handler, { withAuth: true })
}

export function hasRecentAal2(claims: JwtPayload | undefined, nowSeconds = Date.now() / 1000) {
  return (
    claims?.aal === 'aal2' &&
    typeof claims.iat === 'number' &&
    nowSeconds - claims.iat <= RECENT_AAL2_SECONDS
  )
}

export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  if (!isAvailable())
    return res.status(404).json({ code: 'project_not_found', message: 'Not found' })
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', ['GET', 'POST'])
    return res.status(405).json({ code: 'validation_failed', message: 'Method not allowed' })
  }
  if (Array.isArray(req.query.ref)) {
    return res.status(400).json({ code: 'validation_failed', message: 'Invalid ref parameter' })
  }
  const projectRef = String(req.query.ref)
  const allowed = await guardProjectRoute(res, claims, {
    action: req.method === 'GET' ? PermissionAction.READ : PermissionAction.UPDATE,
    projectRef,
    resource: 'custom_config_gotrue',
  })
  if (!allowed) return

  const correlationId =
    (typeof req.headers['x-correlation-id'] === 'string' && req.headers['x-correlation-id']) ||
    randomUUID()
  const actor = claims?.sub ?? 'unknown'
  try {
    if (req.method === 'GET') {
      return res.status(200).json(await getAuthApplyStatus(projectRef, { actor, correlationId }))
    }

    const parsed = applyBodySchema.safeParse(req.body)
    const idempotencyKey = req.headers['idempotency-key']
    if (!parsed.success || typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
      return res.status(400).json({
        code: 'validation_failed',
        message: 'Apply requires expectedGeneration and an Idempotency-Key header',
      })
    }
    // Applying recreates the Auth service, so it follows the lifecycle rule
    // for disruptive actions: a recent AAL2 session.
    if (!hasRecentAal2(claims)) {
      return res.status(403).json({
        code: 'aal2_required',
        message: 'A recent AAL2 session is required to apply Auth settings',
      })
    }
    const operation = await applyAuthConfig({
      projectRef,
      expectedGeneration: parsed.data.expectedGeneration,
      confirmOwnership: parsed.data.confirmOwnership,
      idempotencyKey,
      actor,
      correlationId,
      aal: claims?.aal,
      aalAuthenticatedAt: claims?.iat,
    })
    return res.status(202).json({ operation })
  } catch (error) {
    if (error instanceof AuthApplyConflict) {
      return res.status(409).json({ code: error.code, message: error.message })
    }
    if (error instanceof CapabilityUnavailable) {
      return res
        .status(409)
        .json({ code: 'capability_unavailable', message: error.message, blockers: error.blockers })
    }
    if (error instanceof OwnershipPolicyConflict) {
      return res.status(409).json({ code: error.code, message: error.message })
    }
    if (error instanceof ConfigurationConflictError || error instanceof CapacityExceededError) {
      return res.status(409).json({ code: error.code, message: error.message })
    }
    throw error
  }
}
