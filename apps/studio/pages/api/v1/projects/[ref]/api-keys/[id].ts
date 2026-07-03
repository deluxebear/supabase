import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { getNonPlatformApiKeyById, parseRevealQuery } from '@/lib/api/self-hosted/api-keys'
import { checkPermission } from '@/lib/api/self-platform/rbac/enforce'
import {
  ProjectNotFound,
  resolveProjectConnection,
} from '@/lib/api/self-platform/resolve-connection'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

const apiKeyByIdRoute = (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

export default apiKeyByIdRoute

// [self-platform] exported for handler-level tests
export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  const { method } = req

  switch (method) {
    case 'GET':
      return handleGet(req, res, claims)
    default:
      res.setHeader('Allow', ['GET'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

const handleGet = async (req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) => {
  const idParam = req.query.id
  const id = Array.isArray(idParam) ? idParam[0] : idParam

  if (!id) {
    return res.status(404).json({ error: { message: 'API key not found' } })
  }

  const reveal = parseRevealQuery(req.query.reveal)

  // [self-platform] Resolve the registry project by ref so multi-project
  // deployments reveal the right key. Plain self-hosted keeps the historical
  // global-env path (getNonPlatformApiKeyById(id, reveal) with no resolved
  // arg) — mirrors the sibling list route (api-keys.ts).
  if (!IS_SELF_PLATFORM) {
    const apiKey = getNonPlatformApiKeyById(id, reveal)
    if (!apiKey) {
      return res.status(404).json({ error: { message: 'API key not found' } })
    }
    return res.status(200).json(apiKey)
  }

  try {
    const conn = await resolveProjectConnection(String(req.query.ref))
    // [self-platform] M3.0 Class C guard (spec §7.3): this is a
    // shared-stack-wide credential — Owner/Administrator only. Resolver
    // 404 above wins for unknown refs (404 before 403).
    const canReadSecrets = await checkPermission(claims, {
      action: PermissionAction.SECRETS_READ,
      resource: 'projects',
      projectRef: String(req.query.ref),
    })
    if (!canReadSecrets) return res.status(403).json({ message: 'Forbidden' })
    const apiKey = getNonPlatformApiKeyById(id, reveal, conn)

    if (!apiKey) {
      return res.status(404).json({ error: { message: 'API key not found' } })
    }

    return res.status(200).json(apiKey)
  } catch (err) {
    if (err instanceof ProjectNotFound) {
      return res.status(404).json({ message: 'Project not found' })
    }
    throw err
  }
}
