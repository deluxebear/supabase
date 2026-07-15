import { randomUUID } from 'node:crypto'
import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import type { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { CapabilityUnavailable, requireProjectCapability } from '@/lib/api/self-platform/attachment'
import {
  deleteFunction,
  deployFunction,
  functionDeleteInputSchema,
  FunctionDeploymentConflict,
  functionDeploymentInputSchema,
  listFunctionDeployments,
} from '@/lib/api/self-platform/function-deployments'
import {
  ManagementTrustConflict,
  ManagementTrustDownstreamError,
} from '@/lib/api/self-platform/management-trust'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { STUDIO_CAPABILITIES, STUDIO_DEPLOYMENT_PROFILE } from '@/lib/constants/deployment-profile'

export const config = { api: { bodyParser: { sizeLimit: '28mb' } } }

function isAvailable() {
  return STUDIO_DEPLOYMENT_PROFILE === 'fleet' && STUDIO_CAPABILITIES.remoteFunctionsDeployment
}

export default function route(req: NextApiRequest, res: NextApiResponse) {
  if (!isAvailable()) {
    return res.status(404).json({ code: 'project_not_found', message: 'Not found' })
  }
  return apiWrapper(req, res, handler, { withAuth: true })
}

export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  if (!isAvailable()) {
    return res.status(404).json({ code: 'project_not_found', message: 'Not found' })
  }
  if (Array.isArray(req.query.ref)) {
    return res.status(400).json({ code: 'validation_failed', message: 'Invalid ref parameter' })
  }
  if (!['GET', 'POST', 'DELETE'].includes(req.method ?? '')) {
    res.setHeader('Allow', ['GET', 'POST', 'DELETE'])
    return res.status(405).json({ code: 'validation_failed', message: 'Method not allowed' })
  }
  const projectRef = String(req.query.ref)
  const action =
    req.method === 'GET' ? PermissionAction.FUNCTIONS_READ : PermissionAction.FUNCTIONS_WRITE
  const isAllowed = await guardProjectRoute(res, claims, { action, projectRef })
  if (!isAllowed) return

  try {
    if (req.method === 'GET') {
      await requireProjectCapability(projectRef, 'functions.read')
      res.setHeader('Cache-Control', 'no-store')
      return res.status(200).json({ functions: await listFunctionDeployments(projectRef) })
    }
    const idempotencyKey = req.headers['idempotency-key']
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
      return res.status(400).json({
        code: 'validation_failed',
        message: 'Idempotency-Key header is required',
      })
    }
    const actor = claims?.sub ?? 'unknown'
    const correlationId =
      (typeof req.headers['x-correlation-id'] === 'string' && req.headers['x-correlation-id']) ||
      randomUUID()
    if (req.method === 'POST') {
      const parsed = functionDeploymentInputSchema.safeParse({
        ...req.body,
        idempotencyKey,
      })
      if (!parsed.success) {
        return res.status(400).json({
          code: 'validation_failed',
          message: 'Function deployment input is invalid',
          details: parsed.error.flatten(),
        })
      }
      return res.status(202).json({
        deployment: await deployFunction({ projectRef, value: parsed.data, actor, correlationId }),
      })
    }
    const parsed = functionDeleteInputSchema.safeParse({ ...req.body, idempotencyKey })
    if (!parsed.success) {
      return res.status(400).json({
        code: 'validation_failed',
        message: 'Function deletion input is invalid',
        details: parsed.error.flatten(),
      })
    }
    return res.status(202).json({
      deployment: await deleteFunction({ projectRef, value: parsed.data, actor, correlationId }),
    })
  } catch (error) {
    if (error instanceof CapabilityUnavailable) {
      return res.status(409).json({
        code: 'capability_unavailable',
        message: error.message,
        blockers: error.blockers,
      })
    }
    if (error instanceof FunctionDeploymentConflict || error instanceof ManagementTrustConflict) {
      return res.status(409).json({ code: error.code, message: error.message })
    }
    if (error instanceof ManagementTrustDownstreamError) {
      return res.status(error.status).json({ code: error.code, message: error.message })
    }
    throw error
  }
}
