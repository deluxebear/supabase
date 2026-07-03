import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import { NextApiRequest, NextApiResponse } from 'next'

import { constructHeaders } from '@/lib/api/apiHelpers'
import apiWrapper from '@/lib/api/apiWrapper'
import { executeQuery } from '@/lib/api/self-hosted/query'
import { PgMetaDatabaseError } from '@/lib/api/self-hosted/types'
import { checkPermissionWithContext } from '@/lib/api/self-platform/rbac/enforce'
import { effectiveBaseRoleName } from '@/lib/api/self-platform/rbac/expand'
import {
  ProjectNotFound,
  resolveProjectConnection,
} from '@/lib/api/self-platform/resolve-connection'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: true })

// [self-platform] exported for handler-level tests
export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  const { method } = req

  switch (method) {
    case 'POST':
      return handlePost(req, res, claims)
    default:
      res.setHeader('Allow', ['POST'])
      res.status(405).json({ error: { message: `Method ${method} Not Allowed` } })
  }
}

const handlePost = async (req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) => {
  const { query } = req.body
  const headers = constructHeaders(req.headers)

  // [self-platform] Thread the route's ref through so self-platform builds
  // query the SELECTED project's DB, not the global/default one. Unknown ref
  // (self-platform only) maps to 404, consistent with Task 6/7's
  // resolveProjectConnection error handling.
  try {
    let readOnly = false
    if (IS_SELF_PLATFORM) {
      // [self-platform] 404 before 403: resolve first (throws ProjectNotFound
      // into the catch below), then check, then pick the DSN tier (spec §7.4).
      await resolveProjectConnection(String(req.query.ref))
      const { can, ctx } = await checkPermissionWithContext(claims, {
        action: PermissionAction.TENANT_SQL_QUERY,
        resource: 'projects',
        projectRef: String(req.query.ref),
      })
      if (!can) return res.status(403).json({ message: 'Forbidden' })
      readOnly = ctx !== null && effectiveBaseRoleName(ctx, String(req.query.ref)) === 'Read-only'
    }

    const { data, error } = await executeQuery({
      query,
      headers,
      projectRef: String(req.query.ref),
      readOnly,
    })

    if (error) {
      if (error instanceof PgMetaDatabaseError) {
        const { statusCode, message, formattedError } = error
        return res.status(statusCode).json({ message, formattedError })
      }
      const { message } = error
      return res.status(500).json({ message, formattedError: message })
    } else {
      return res.status(200).json(data)
    }
  } catch (err) {
    if (err instanceof ProjectNotFound) {
      return res.status(404).json({ message: 'Project not found' })
    }
    throw err
  }
}
