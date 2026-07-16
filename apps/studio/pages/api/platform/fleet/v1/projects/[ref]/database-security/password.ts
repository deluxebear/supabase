import { randomUUID } from 'node:crypto'
import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import type { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { CapabilityUnavailable } from '@/lib/api/self-platform/attachment'
import {
  rotateDatabasePassword,
  rotateDatabasePasswordSchema,
} from '@/lib/api/self-platform/database-security'
import { ManagementTrustDownstreamError } from '@/lib/api/self-platform/management-trust'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { STUDIO_DEPLOYMENT_PROFILE } from '@/lib/constants/deployment-profile'

export const config = { api: { bodyParser: { sizeLimit: '8kb' } } }

export default function route(req: NextApiRequest, res: NextApiResponse) {
  if (STUDIO_DEPLOYMENT_PROFILE !== 'fleet') return res.status(404).json({ message: 'Not found' })
  return apiWrapper(req, res, handler, { withAuth: true })
}

export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  if (STUDIO_DEPLOYMENT_PROFILE !== 'fleet') return res.status(404).json({ message: 'Not found' })
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST'])
    return res.status(405).json({ message: 'Method not allowed' })
  }
  if (Array.isArray(req.query.ref))
    return res.status(400).json({ message: 'Invalid ref parameter' })
  const projectRef = String(req.query.ref)
  const allowed = await guardProjectRoute(res, claims, {
    action: PermissionAction.UPDATE,
    projectRef,
    resource: 'projects',
  })
  if (!allowed) return
  const idempotencyKey = req.headers['idempotency-key']
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0)
    return res
      .status(400)
      .json({ code: 'validation_failed', message: 'Idempotency-Key is required' })
  const parsed = rotateDatabasePasswordSchema.safeParse(req.body)
  if (!parsed.success)
    return res
      .status(400)
      .json({
        code: 'validation_failed',
        message: 'Password rotation input is invalid',
        details: parsed.error.flatten(),
      })
  try {
    const result = await rotateDatabasePassword({
      projectRef,
      value: parsed.data,
      idempotencyKey,
      actor: claims?.sub ?? 'unknown',
      correlationId:
        typeof req.headers['x-correlation-id'] === 'string'
          ? req.headers['x-correlation-id']
          : randomUUID(),
    })
    // Password values are intentionally absent from this response.
    return res.status(200).json({ result })
  } catch (error) {
    if (error instanceof CapabilityUnavailable)
      return res
        .status(409)
        .json({ code: 'capability_unavailable', message: error.message, blockers: error.blockers })
    if (error instanceof ManagementTrustDownstreamError)
      return res.status(error.status).json({ code: error.code, message: error.message })
    throw error
  }
}
