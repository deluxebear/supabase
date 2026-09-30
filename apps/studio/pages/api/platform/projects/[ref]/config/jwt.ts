import { randomUUID } from 'node:crypto'
import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import type { NextApiRequest, NextApiResponse } from 'next'

import { apiWrapper } from '@/lib/api/apiWrapper'
import {
  CapacityExceededError,
  ConfigurationConflictError,
} from '@/lib/api/self-platform/desired-state'
import {
  applyJWTConfiguration,
  getJWTConfigurationStatus,
  jwtConfigurationInputSchema,
} from '@/lib/api/self-platform/jwt-configuration'
import { OwnershipPolicyConflict } from '@/lib/api/self-platform/ownership-policy'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { hasRecentAal2 } from '@/lib/api/self-platform/recent-aal2'
import { ServiceConfigApplyConflict } from '@/lib/api/self-platform/service-config-apply'
import { STUDIO_DEPLOYMENT_PROFILE } from '@/lib/constants/deployment-profile'

export default function route(req: NextApiRequest, res: NextApiResponse) {
  if (STUDIO_DEPLOYMENT_PROFILE !== 'fleet') return res.status(404).json({ message: 'Not found' })
  return apiWrapper(req, res, handler, { withAuth: true })
}

export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  res.setHeader('Cache-Control', 'no-store')
  if (STUDIO_DEPLOYMENT_PROFILE !== 'fleet') return res.status(404).json({ message: 'Not found' })
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', ['GET', 'POST'])
    return res.status(405).json({ message: 'Method not allowed' })
  }
  if (typeof req.query.ref !== 'string')
    return res.status(400).json({ message: 'Invalid project ref' })
  const projectRef = req.query.ref
  if (
    !(await guardProjectRoute(res, claims, {
      action: PermissionAction.SECRETS_READ,
      resource: 'projects',
      projectRef,
    }))
  )
    return
  if (
    req.method === 'POST' &&
    !(await guardProjectRoute(res, claims, {
      action: PermissionAction.INFRA_EXECUTE,
      resource: 'projects',
      projectRef,
    }))
  )
    return
  const request = { actor: claims?.sub ?? 'unknown', correlationId: randomUUID() }
  try {
    if (req.method === 'GET')
      return res.status(200).json(await getJWTConfigurationStatus(projectRef, request))
    const parsed = jwtConfigurationInputSchema.safeParse(req.body)
    const idempotencyKey = req.headers['idempotency-key']
    if (
      !parsed.success ||
      typeof idempotencyKey !== 'string' ||
      idempotencyKey.length < 1 ||
      idempotencyKey.length > 128
    )
      return res.status(400).json({
        message:
          'A valid JWT configuration, token invalidation confirmation, and Idempotency-Key are required.',
      })
    if (!hasRecentAal2(claims))
      return res.status(403).json({
        code: 'aal2_required',
        message: 'A recent AAL2 session is required to change JWT keys.',
      })
    const operation = await applyJWTConfiguration({
      ...parsed.data,
      ...request,
      projectRef,
      idempotencyKey,
      aal: claims?.aal,
      aalAuthenticatedAt: claims?.iat,
    })
    return res.status(202).json({ operation })
  } catch (error) {
    if (
      error instanceof ServiceConfigApplyConflict ||
      error instanceof ConfigurationConflictError ||
      error instanceof CapacityExceededError ||
      error instanceof OwnershipPolicyConflict
    )
      return res.status(409).json({ code: error.code, message: error.message })
    throw error
  }
}
