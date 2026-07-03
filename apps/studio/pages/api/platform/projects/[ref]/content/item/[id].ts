import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { getSnippet } from '@/lib/api/snippets.utils'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

const wrappedHandler = (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

const RBAC_ACTIONS: Record<string, string> = {
  GET: PermissionAction.READ,
}

// [self-platform] exported for handler-level tests
export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  const { method } = req

  // [self-platform] M3.0 RBAC guard (spec §7.3). 404-before-403 lives inside
  // guardProjectRoute (resolver-first) — a behavior change here: this route
  // previously ignored `ref` entirely.
  if (IS_SELF_PLATFORM) {
    const action = RBAC_ACTIONS[method ?? '']
    if (action) {
      const ok = await guardProjectRoute(res, claims, {
        action,
        resource: 'user_content',
        projectRef: String(req.query.ref),
      })
      if (!ok) return
    }
  }

  switch (method) {
    case 'GET':
      return handleGetAll(req, res)
    default:
      res.setHeader('Allow', ['GET'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

const handleGetAll = async (req: NextApiRequest, res: NextApiResponse) => {
  try {
    const snippet = await getSnippet(req.query.id as string)

    return res.status(200).json(snippet)
  } catch (error) {
    if (error instanceof Error && error.message.includes('not found')) {
      return res.status(404).json({ message: 'Content not found.' })
    }
    return res.status(500).json({ data: null, error: { message: 'Internal Server Error' } })
  }
}

export default wrappedHandler
