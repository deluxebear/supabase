import { randomUUID } from 'node:crypto'
import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import type { NextApiRequest, NextApiResponse } from 'next'

import { applyRevealToApiKey, parseRevealQuery } from '../self-hosted/api-keys'
import { apiKeyCreateSchema, apiKeyUpdateSchema, mutateManagedAPIKeys } from './api-key-management'
import { CapacityExceededError, ConfigurationConflictError } from './desired-state'
import { OwnershipPolicyConflict } from './ownership-policy'
import { guardProjectRoute } from './rbac/enforce'
import { hasRecentAal2 } from './recent-aal2'
import { ServiceConfigApplyConflict } from './service-config-apply'

export async function handleManagedAPIKeyMutation(
  req: NextApiRequest,
  res: NextApiResponse,
  claims?: JwtPayload
) {
  res.setHeader('Cache-Control', 'no-store')
  if (typeof req.query.ref !== 'string')
    return res.status(400).json({ message: 'Invalid project ref' })
  const projectRef = req.query.ref
  for (const action of [PermissionAction.SECRETS_READ, PermissionAction.INFRA_EXECUTE]) {
    if (!(await guardProjectRoute(res, claims, { action, resource: 'projects', projectRef })))
      return
  }
  if (!hasRecentAal2(claims))
    return res
      .status(403)
      .json({
        code: 'aal2_required',
        message: 'A recent AAL2 session is required to manage API keys.',
      })
  const request = { actor: claims?.sub ?? 'unknown', correlationId: randomUUID() }
  const idempotencyKey = req.headers['idempotency-key']
  if (
    typeof idempotencyKey !== 'string' ||
    idempotencyKey.length < 1 ||
    idempotencyKey.length > 128
  )
    return res.status(400).json({ message: 'A valid Idempotency-Key is required.' })
  try {
    let change: Parameters<typeof mutateManagedAPIKeys>[0]['change']
    if (req.method === 'POST') {
      const parsed = apiKeyCreateSchema.safeParse(req.body)
      if (!parsed.success)
        return res.status(400).json({ message: 'Invalid API key configuration.' })
      change = { kind: 'create', input: parsed.data }
    } else {
      if (typeof req.query.id !== 'string')
        return res.status(400).json({ message: 'Invalid API key ID.' })
      if (req.method === 'DELETE') change = { kind: 'delete', id: req.query.id }
      else {
        const parsed = apiKeyUpdateSchema.safeParse(req.body)
        if (!parsed.success)
          return res.status(400).json({ message: 'Invalid API key configuration.' })
        change = { kind: 'update', id: req.query.id, input: parsed.data }
      }
    }
    const key = await mutateManagedAPIKeys({
      projectRef,
      change,
      request,
      idempotencyKey,
      aal: claims?.aal,
      aalAuthenticatedAt: claims?.iat,
    })
    return res
      .status(req.method === 'POST' ? 201 : 200)
      .json(applyRevealToApiKey(key, parseRevealQuery(req.query.reveal)))
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
