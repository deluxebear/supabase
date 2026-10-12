import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import { components } from 'api-types'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { postgrestUpdateSchema } from '@/lib/api/self-platform/postgrest-config'
import { checkPermission, guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import {
  ProjectNotFound,
  resolveProjectConnection,
} from '@/lib/api/self-platform/resolve-connection'
import {
  mergeStoredServiceConfig,
  readStoredServiceConfig,
} from '@/lib/api/self-platform/service-settings'
import { STUDIO_DEPLOYMENT_PROFILE } from '@/lib/constants/deployment-profile'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  const { method } = req

  switch (method) {
    case 'GET':
      return handleGet(req, res, claims)
    case 'PATCH':
      return handlePatch(req, res, claims)
    default:
      res.setHeader('Allow', ['GET', 'PATCH'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

const handleGet = async (req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) => {
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

  // [self-platform] Fleet: the operator's stored overrides are the desired
  // settings; they replace the stack defaults until applied and afterwards.
  const stored = isFleet() ? await readStoredServiceConfig(String(req.query.ref), 'postgrest') : {}
  const overrides = postgrestUpdateSchema.safeParse(stored)
  const saved = overrides.success ? overrides.data : {}

  const responseObj: components['schemas']['GetPostgrestConfigResponse_Output'] = {
    db_anon_role: 'anon',
    db_extra_search_path:
      saved.db_extra_search_path ?? process.env.PGRST_DB_EXTRA_SEARCH_PATH ?? 'public',
    db_schema: saved.db_schema ?? process.env.PGRST_DB_SCHEMAS ?? 'public,storage,graphql_public',
    jwt_secret: jwtSecret,
    max_rows: saved.max_rows ?? (Number(process.env.PGRST_DB_MAX_ROWS) || 1000),
    role_claim_key: '.role',
  }

  return res.status(200).json(responseObj)
}

const isFleet = () => IS_SELF_PLATFORM && STUDIO_DEPLOYMENT_PROFILE === 'fleet'

// [self-platform] Fleet only: stores the settings as desired state. They reach
// the running PostgREST service when applied through
// config/postgrest/apply, which recreates the service.
const handlePatch = async (req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) => {
  if (!isFleet()) {
    res.setHeader('Allow', ['GET'])
    return res.status(405).json({ data: null, error: { message: 'Method PATCH Not Allowed' } })
  }
  const projectRef = String(req.query.ref)
  const allowed = await guardProjectRoute(res, claims, {
    action: PermissionAction.UPDATE,
    resource: 'custom_config_postgrest',
    projectRef,
  })
  if (!allowed) return
  const parsed = postgrestUpdateSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid PostgREST settings' })
  }
  // A null value (for example an empty db_pool) clears that override.
  const stored = await mergeStoredServiceConfig({
    projectRef,
    service: 'postgrest',
    patch: parsed.data,
    actor: claims?.sub ?? 'unknown',
  })
  return res.status(200).json(stored)
}
