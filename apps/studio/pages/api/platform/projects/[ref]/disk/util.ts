import type { JwtPayload } from '@supabase/supabase-js'
import type { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { runtimeInventoryForRoute } from '@/lib/api/self-platform/runtime-inventory-route'
import { STUDIO_DEPLOYMENT_PROFILE } from '@/lib/constants/deployment-profile'

export default function route(req: NextApiRequest, res: NextApiResponse) {
  if (STUDIO_DEPLOYMENT_PROFILE !== 'fleet')
    return res.status(404).json({ code: 'project_not_found', message: 'Not found' })
  return apiWrapper(req, res, handler, { withAuth: true })
}

export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res.status(405).json({ code: 'validation_failed', message: 'Method not allowed' })
  }
  const inventory = await runtimeInventoryForRoute(req, res, claims)
  if (!inventory) return
  return res.status(200).json({
    metrics: {
      fs_avail_bytes: inventory.disk.filesystemAvailableBytes,
      fs_size_bytes: inventory.disk.filesystemSizeBytes,
      fs_used_bytes: inventory.disk.filesystemUsedBytes,
    },
    timestamp: inventory.observedAt,
  })
}
