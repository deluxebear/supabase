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
  const current = `supabase-postgres-${inventory.upgrade.currentPostgresVersion}`
  return res.status(200).json({
    current_app_version: current,
    current_app_version_release_channel: 'ga',
    duration_estimate_hours: 0,
    eligible: inventory.upgrade.eligible,
    latest_app_version: `supabase-postgres-${inventory.upgrade.latestSupportedVersion}`,
    legacy_auth_custom_roles: [],
    objects_to_be_dropped: [],
    target_upgrade_versions: inventory.upgrade.targetVersions.map((version) => ({
      app_version: `supabase-postgres-${version}`,
      postgres_version: version.split('.')[0],
      release_channel: 'ga',
    })),
    unsupported_extensions: [],
    user_defined_objects_in_internal_schemas: [],
    validation_errors: [],
    warnings: [{ type: 'operator_estimator_gate' }],
    blockers: inventory.upgrade.blockers,
    preflight: inventory.upgrade.checks,
    progress: inventory.upgrade.progress,
    rollback: inventory.upgrade.rollback,
    recovery: inventory.upgrade.recovery,
  })
}
