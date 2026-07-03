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
      return handleGet(req, res, claims)
    case 'HEAD':
      return handleHead(req, res)
    default:
      res.setHeader('Allow', ['GET', 'HEAD'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

const handleGet = async (req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) => {
  // [self-platform] Proxy the resolved project's REST endpoint; plain
  // self-hosted keeps the global env target byte-identically.
  let restUrl = `${process.env.SUPABASE_URL}/rest/v1/`
  let apikey = process.env.SUPABASE_SERVICE_KEY!
  if (IS_SELF_PLATFORM) {
    try {
      const conn = await resolveProjectConnection(String(req.query.ref))
      if (conn.row) {
        restUrl = `${conn.supabaseUrl}/rest/v1/`
        apikey = conn.serviceKey
      }
    } catch (err) {
      if (err instanceof ProjectNotFound) {
        return res.status(404).json({ message: 'Project not found' })
      }
      throw err
    }
    // [self-platform] M3.0 Class R guard (spec §7.3): service-key proxy =
    // data-plane WRITE channel (bypasses the read-only DSN) -> Developer+.
    const canWrite = await checkPermission(claims, {
      action: PermissionAction.TENANT_SQL_ADMIN_WRITE,
      resource: 'tables',
      projectRef: String(req.query.ref),
    })
    if (!canWrite) return res.status(403).json({ message: 'Forbidden' })
  }
  const response = await fetch(restUrl, { method: 'GET', headers: { apikey } })
  if (response.ok) {
    const data = await response.json()

    return res.status(200).json(data)
  }

  return res.status(500).json({ error: { message: 'Internal Server Error' } })
}

const handleHead = async (_req: NextApiRequest, res: NextApiResponse) => {
  res.status(200).end()
}
