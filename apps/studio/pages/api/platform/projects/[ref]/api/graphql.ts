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
    case 'POST':
      return handleGet(req, res, claims)

    default:
      res.setHeader('Allow', ['POST'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

const handleGet = async (req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) => {
  let gqlUrl = `${process.env.SUPABASE_URL}/graphql/v1`
  let apikey = process.env.SUPABASE_SERVICE_KEY!
  let anonKey = process.env.SUPABASE_ANON_KEY
  if (IS_SELF_PLATFORM) {
    try {
      const conn = await resolveProjectConnection(String(req.query.ref))
      if (conn.row) {
        gqlUrl = `${conn.supabaseUrl}/graphql/v1`
        apikey = conn.serviceKey
        anonKey = conn.anonKey
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
  const authorizationHeader = req.headers['x-graphql-authorization']
  const response = await fetch(gqlUrl, {
    method: 'POST',
    headers: {
      apikey,
      Authorization:
        (Array.isArray(authorizationHeader) ? authorizationHeader[0] : authorizationHeader) ??
        `Bearer ${anonKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(req.body),
  })
  if (response.ok) {
    const data = await response.json()

    return res.status(200).json(data)
  }

  return res.status(500).json({ error: { message: 'Internal Server Error' } })
}
