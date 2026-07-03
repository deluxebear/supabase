import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import { NextApiRequest, NextApiResponse } from 'next'

import { constructHeaders } from '@/lib/api/apiHelpers'
import apiWrapper from '@/lib/api/apiWrapper'
import { DEFAULT_EXPOSED_SCHEMAS } from '@/lib/api/self-hosted/constants'
import { getLints } from '@/lib/api/self-hosted/lints'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { ProjectNotFound } from '@/lib/api/self-platform/resolve-connection'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

// [self-platform] Spec §7.3 originally said POST — the route is GET-only;
// recorded correction (Task 14).
const RBAC_ACTIONS: Record<string, string> = {
  GET: PermissionAction.TENANT_SQL_QUERY,
}

// [self-platform] exported for handler-level tests
export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  const { method } = req

  // [self-platform] M3.0 RBAC guard (spec §7.3). 404-before-403 lives inside
  // guardProjectRoute (resolver-first).
  if (IS_SELF_PLATFORM) {
    const action = RBAC_ACTIONS[method ?? '']
    if (action) {
      const ok = await guardProjectRoute(res, claims, {
        action,
        projectRef: String(req.query.ref),
      })
      if (!ok) return
    }
  }

  switch (method) {
    case 'GET':
      try {
        const { data, error } = await getLints({
          headers: constructHeaders(req.headers),
          exposedSchemas: DEFAULT_EXPOSED_SCHEMAS,
          // [self-platform] Route lints at the selected project's DB.
          projectRef: IS_SELF_PLATFORM ? String(req.query.ref) : undefined,
        })
        if (error) {
          return res.status(400).json(error)
        } else {
          return res.status(200).json(data)
        }
      } catch (err) {
        if (err instanceof ProjectNotFound) {
          return res.status(404).json({ message: 'Project not found' })
        }
        throw err
      }
    default:
      res.setHeader('Allow', ['GET'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}
