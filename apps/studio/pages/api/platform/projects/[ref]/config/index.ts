import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { checkPermission } from '@/lib/api/self-platform/rbac/enforce'
import {
  ProjectNotFound,
  resolveProjectConnection,
} from '@/lib/api/self-platform/resolve-connection'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  const { method } = req

  switch (method) {
    case 'GET':
      return handleGetAll(req, res, claims)
    case 'PATCH':
      return handlePatch(req, res)
    default:
      res.setHeader('Allow', ['GET'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

const handleGetAll = async (req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) => {
  // [self-platform] jwt_secret must come from the resolved project; other
  // fields are stack-level PostgREST config the registry doesn't model, so
  // they keep their historical values (mirrors getProjectSettings).
  let jwtSecret =
    process.env.AUTH_JWT_SECRET ?? 'super-secret-jwt-token-with-at-least-32-characters-long'
  if (IS_SELF_PLATFORM) {
    try {
      const conn = await resolveProjectConnection(String(req.query.ref))
      // [self-platform] M3.0 Class C guard (spec §7.3): jwt_secret is a
      // shared-stack-wide credential — Owner/Administrator only. Resolver
      // 404 above wins for unknown refs (404 before 403).
      const canReadSecrets = await checkPermission(claims, {
        action: PermissionAction.SECRETS_READ,
        resource: 'projects',
        projectRef: String(req.query.ref),
      })
      if (!canReadSecrets) return res.status(403).json({ message: 'Forbidden' })
      if (conn.row) jwtSecret = conn.jwtSecret
    } catch (err) {
      if (err instanceof ProjectNotFound) {
        return res.status(404).json({ message: 'Project not found' })
      }
      throw err
    }
  }
  return res.status(200).json({
    db_anon_role: 'anon',
    db_extra_search_path: 'public',
    db_schema: 'public, storage',
    jwt_secret: jwtSecret,
    max_rows: 100,
    role_claim_key: '.role',
  })
}

const handlePatch = async (_req: NextApiRequest, res: NextApiResponse) => {
  // Platform specific endpoint
  return res.status(200).json({})
}
