import { randomUUID } from 'node:crypto'
import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import type { NextApiRequest, NextApiResponse } from 'next'
import { z } from 'zod'

import apiWrapper from '@/lib/api/apiWrapper'
import {
  deleteFunctionSecrets,
  functionSecretInputSchema,
  functionSecretNameSchema,
  listFunctionSecretMetadata,
  upsertFunctionSecrets,
} from '@/lib/api/self-platform/function-secrets'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { STUDIO_CAPABILITIES, STUDIO_DEPLOYMENT_PROFILE } from '@/lib/constants/deployment-profile'

function isAvailable() {
  return STUDIO_DEPLOYMENT_PROFILE === 'fleet' && STUDIO_CAPABILITIES.remoteFunctionsDeployment
}

export default function route(req: NextApiRequest, res: NextApiResponse) {
  if (!isAvailable()) return res.status(404).json({ message: 'Not found' })
  return apiWrapper(req, res, handler, { withAuth: true })
}

export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  if (!isAvailable()) return res.status(404).json({ message: 'Not found' })
  if (Array.isArray(req.query.ref)) {
    return res.status(400).json({ message: 'Invalid ref parameter' })
  }
  if (!['GET', 'POST', 'DELETE'].includes(req.method ?? '')) {
    res.setHeader('Allow', ['GET', 'POST', 'DELETE'])
    return res.status(405).json({ message: 'Method not allowed' })
  }
  const projectRef = String(req.query.ref)
  const action =
    req.method === 'GET' ? PermissionAction.FUNCTIONS_SECRET_READ : PermissionAction.SECRETS_WRITE
  if (!(await guardProjectRoute(res, claims, { action, projectRef }))) return

  try {
    if (req.method === 'GET') {
      res.setHeader('Cache-Control', 'no-store')
      return res.status(200).json(await listFunctionSecretMetadata(projectRef))
    }
    const actor = claims?.sub ?? 'unknown'
    const correlationId =
      (typeof req.headers['x-correlation-id'] === 'string' && req.headers['x-correlation-id']) ||
      randomUUID()
    if (req.method === 'POST') {
      const parsed = z.array(functionSecretInputSchema).min(1).max(100).safeParse(req.body)
      if (!parsed.success) return res.status(400).json({ message: 'Secret input is invalid' })
      await upsertFunctionSecrets({ projectRef, secrets: parsed.data, actor, correlationId })
      return res.status(201).json({ message: 'Secrets stored' })
    }
    const parsed = z.array(functionSecretNameSchema).min(1).max(100).safeParse(req.body)
    if (!parsed.success) return res.status(400).json({ message: 'Secret names are invalid' })
    await deleteFunctionSecrets({ projectRef, names: parsed.data, actor, correlationId })
    return res.status(200).json({ message: 'Secrets deleted' })
  } catch (error) {
    if (
      error instanceof z.ZodError ||
      (error instanceof Error && error.message.includes('unique'))
    ) {
      return res.status(400).json({ message: error.message })
    }
    throw error
  }
}
