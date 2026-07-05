// [self-platform] M6.0: real per-service health probing in self-platform mode
// (spec §4); plain self-hosted keeps the M1 contract-minimal always-healthy
// stub byte-identically. Typed against api-types so upstream contract changes
// surface at compile time.
import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import type { components, paths } from 'api-types'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { probeStackHealth, writeThroughStatus } from '@/lib/api/self-platform/health'
import type { ServiceProbeResult } from '@/lib/api/self-platform/health'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

type HealthResponse =
  paths['/v1/projects/{ref}/health']['get']['responses']['200']['content']['application/json']
type ServiceName = components['schemas']['V1ServiceHealthResponse']['name']

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: true })

// [self-platform] exported for handler-level tests
export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res
      .status(405)
      .json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }

  const { services } = req.query
  const requested = (typeof services === 'string' ? services.split(',') : []) as ServiceName[]

  if (!IS_SELF_PLATFORM) {
    // Plain self-hosted: M1 static stub, unchanged.
    const response: HealthResponse = requested.map((name) => ({
      name,
      healthy: true,
      status: 'ACTIVE_HEALTHY',
    }))
    return res.status(200).json(response)
  }

  if (Array.isArray(req.query.ref)) {
    return res.status(400).json({ message: 'Invalid ref parameter' })
  }
  const ref = String(req.query.ref)
  const ok = await guardProjectRoute(res, claims, {
    action: PermissionAction.READ,
    projectRef: ref,
    resource: 'projects',
  })
  if (!ok) return

  const { results, fresh } = await probeStackHealth(ref)
  if (fresh) await writeThroughStatus(ref, results)

  const byName = new Map<string, ServiceProbeResult>(results.map((r) => [r.name, r]))
  const response: HealthResponse = requested
    .filter((name) => byName.has(name))
    .map((name) => {
      const r = byName.get(name)!
      return {
        name,
        healthy: r.healthy,
        status: r.status,
        ...(r.error !== undefined ? { error: r.error } : {}),
        ...(r.info !== undefined ? { info: r.info } : {}),
        // upstream V1ServiceHealthResponse.name lags (no 'edge_function'
        // literal) and status lacks DISABLED — same api-types type-lag class
        // as M6.0; ServiceStatus.tsx pre-widens on the client.
      } as HealthResponse[number]
    })
  return res.status(200).json(response)
}
