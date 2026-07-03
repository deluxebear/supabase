import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import { paths } from 'api-types'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { getSnippets } from '@/lib/api/snippets.utils'
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

type GetRequestData = paths['/platform/projects/{ref}/content/count']['get']['parameters']['query']

const handleGetAll = async (req: NextApiRequest, res: NextApiResponse) => {
  const params = req.query as GetRequestData

  try {
    const { snippets } = await getSnippets({
      searchTerm: params?.name,
      includeContent: false,
    })
    if (params?.name) {
      return res.status(200).json({
        count: snippets.length,
      })
    } else {
      return res.status(200).json({
        shared: snippets.filter((s) => s.visibility === 'project').length,
        favorites: snippets.filter((s) => s.favorite).length,
        private: snippets.filter((s) => s.visibility === 'user').length,
      })
    }
  } catch (error: any) {
    console.error('Error fetching snippets:', error)
    return res.status(500).json({ message: error?.message ?? 'Failed to get count' })
  }
}

export default wrappedHandler
