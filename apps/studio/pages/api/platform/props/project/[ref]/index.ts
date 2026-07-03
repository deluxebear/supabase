import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import {
  ProjectNotFound,
  resolveProjectConnection,
} from '@/lib/api/self-platform/resolve-connection'
import { DEFAULT_PROJECT } from '@/lib/constants/api'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

const RBAC_ACTIONS: Record<string, string> = {
  GET: PermissionAction.READ,
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
      return handleGetAll(req, res)
    default:
      res.setHeader('Allow', ['GET'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

const handleGetAll = async (req: NextApiRequest, res: NextApiResponse) => {
  if (!IS_SELF_PLATFORM) {
    // Platform specific endpoint — plain self-hosted, byte-identical.
    return res.status(200).json({
      project: {
        ...DEFAULT_PROJECT,
        services: [],
      },
    })
  }

  // [self-platform] Per-ref project summary from the resolver.
  try {
    const conn = await resolveProjectConnection(String(req.query.ref))
    return res.status(200).json({
      project: {
        id: conn.row?.id ?? DEFAULT_PROJECT.id,
        ref: conn.ref,
        name: conn.name,
        organization_id: conn.organizationId ?? DEFAULT_PROJECT.organization_id,
        cloud_provider: conn.cloudProvider,
        status: conn.status,
        region: conn.region,
        inserted_at: DEFAULT_PROJECT.inserted_at,
        services: [],
      },
    })
  } catch (err) {
    if (err instanceof ProjectNotFound) {
      return res.status(404).json({ message: 'Project not found' })
    }
    throw err
  }
}
