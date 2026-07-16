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
    return res.status(405).json({
      code: 'capability_unavailable',
      message: 'Fleet Compose volume autoscaling has no registered provider',
    })
  }
  const inventory = await runtimeInventoryForRoute(req, res, claims)
  if (!inventory) return
  return res.status(200).json({
    enabled: false,
    managed_by: 'fleet-agent',
    observed_at: inventory.observedAt,
    blocker: {
      code: 'provider_not_registered',
      message: 'The attached Compose volume does not advertise an autoscaling provider.',
    },
  })
}
