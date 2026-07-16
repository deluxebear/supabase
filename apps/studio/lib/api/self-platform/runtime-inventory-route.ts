import { randomUUID } from 'node:crypto'
import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import type { NextApiRequest, NextApiResponse } from 'next'

import { guardProjectRoute } from './rbac/enforce'
import { getRuntimeInventory, type RuntimeInventory } from './runtime-inventory'

export async function runtimeInventoryForRoute(
  req: NextApiRequest,
  res: NextApiResponse,
  claims?: JwtPayload
): Promise<RuntimeInventory | null> {
  if (Array.isArray(req.query.ref)) {
    res.status(400).json({ code: 'validation_failed', message: 'Invalid ref parameter' })
    return null
  }
  const projectRef = String(req.query.ref)
  const allowed = await guardProjectRoute(res, claims, {
    action: PermissionAction.READ,
    projectRef,
    resource: 'projects',
  })
  if (!allowed) return null
  const correlationId =
    (typeof req.headers['x-correlation-id'] === 'string' && req.headers['x-correlation-id']) ||
    randomUUID()
  return getRuntimeInventory({
    projectRef,
    actor: claims?.sub ?? 'unknown',
    correlationId,
    force: req.query.refresh === 'true',
  })
}

export function bytesToGiB(value: number) {
  return Math.round((value / 1024 ** 3) * 100) / 100
}
