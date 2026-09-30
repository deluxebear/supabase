import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import { NextApiRequest, NextApiResponse } from 'next'

import { apiWrapper } from '@/lib/api/apiWrapper'
import {
  applyRevealToApiKey,
  getNonPlatformApiKeys,
  parseRevealQuery,
} from '@/lib/api/self-hosted/api-keys'
import { listManagedAPIKeys } from '@/lib/api/self-platform/api-key-management'
import { handleManagedAPIKeyMutation } from '@/lib/api/self-platform/api-key-route'
import { checkPermission } from '@/lib/api/self-platform/rbac/enforce'
import {
  ProjectNotFound,
  resolveProjectConnection,
} from '@/lib/api/self-platform/resolve-connection'
import { STUDIO_DEPLOYMENT_PROFILE } from '@/lib/constants/deployment-profile'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

const apiKeysRoute = (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

export default apiKeysRoute

// [self-platform] exported for handler-level tests
export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  const { method } = req

  switch (method) {
    case 'POST':
      if (STUDIO_DEPLOYMENT_PROFILE === 'fleet')
        return handleManagedAPIKeyMutation(req, res, claims)
      res.setHeader('Allow', ['GET'])
      return res
        .status(405)
        .json({ data: null, error: { message: `Method ${method} Not Allowed` } })
    case 'GET':
      return handleGetAll(req, res, claims)
    default:
      res.setHeader('Allow', ['GET'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

const handleGetAll = async (req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) => {
  res.setHeader('Cache-Control', 'no-store')
  const reveal = parseRevealQuery(req.query.reveal)

  // [self-platform] Resolve the registry project by ref so multi-project
  // deployments return the right keys. Plain self-hosted keeps the
  // historical global-env path (getNonPlatformApiKeys() with no arg).
  if (!IS_SELF_PLATFORM) {
    const response = getNonPlatformApiKeys().map((key) => applyRevealToApiKey(key, reveal))
    return res.status(200).json(response)
  }

  try {
    const conn = await resolveProjectConnection(String(req.query.ref))
    // [self-platform] M3.0 Class C guard (spec §7.3): these are
    // shared-stack-wide credentials — Owner/Administrator only. Resolver
    // 404 above wins for unknown refs (404 before 403).
    const canReadSecrets = await checkPermission(claims, {
      action: PermissionAction.SECRETS_READ,
      resource: 'projects',
      projectRef: String(req.query.ref),
    })
    if (!canReadSecrets) return res.status(403).json({ message: 'Forbidden' })
    const keys =
      STUDIO_DEPLOYMENT_PROFILE === 'fleet'
        ? await listManagedAPIKeys(String(req.query.ref), conn)
        : getNonPlatformApiKeys(conn)
    const response = keys.map((key) => applyRevealToApiKey(key, reveal))
    return res.status(200).json(response)
  } catch (err) {
    if (err instanceof ProjectNotFound) {
      return res.status(404).json({ message: 'Project not found' })
    }
    throw err
  }
}
