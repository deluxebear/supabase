import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import { NextApiRequest, NextApiResponse } from 'next'

import { constructHeaders } from '@/lib/api/apiHelpers'
import apiWrapper from '@/lib/api/apiWrapper'
import { generateTypescriptTypes } from '@/lib/api/self-hosted/generate-types'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'
import { ResponseError } from '@/types'

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: true })

// [self-platform] exported for handler-level tests
export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  const { method } = req

  // [self-platform] M3.1 RBAC guard (I2 batch): type generation reads the
  // tenant database schema — same tier as the pg-meta listing family.
  if (IS_SELF_PLATFORM && method === 'GET') {
    const ok = await guardProjectRoute(res, claims, {
      action: PermissionAction.TENANT_SQL_ADMIN_READ,
      projectRef: String(req.query.ref),
    })
    if (!ok) return
  }

  switch (method) {
    case 'GET':
      return handleGetAll(req, res)
    default:
      res.setHeader('Allow', ['GET'])
      res.status(405).json({ error: { message: `Method ${method} Not Allowed` } })
  }
}

const handleGetAll = async (req: NextApiRequest, res: NextApiResponse) => {
  const headers = constructHeaders(req.headers)

  const response = await generateTypescriptTypes({ headers })

  if (response instanceof ResponseError) {
    return res.status(response.code ?? 500).json({ message: response.message })
  }

  return res.status(200).json({ types: response })
}
