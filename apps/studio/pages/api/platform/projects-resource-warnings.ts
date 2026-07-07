// [self-platform] M1 stub → M6.3 real derivation: exhaustion flags computed
// from the latest metrics samples (≥90 critical / ≥80 warning — the same
// thresholds the upstream UI colors at). Keys we cannot honestly derive stay
// null; plain self-hosted keeps the M1 [] stub byte-identically.
import type { JwtPayload } from '@supabase/supabase-js'
import type { paths } from 'api-types'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { executePlatformQuery } from '@/lib/api/self-platform/db'
import { listAllProjectsV2 } from '@/lib/api/self-platform/list-user-projects'
import { getMemberContext } from '@/lib/api/self-platform/members'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

type ResourceWarningsResponse =
  paths['/platform/projects-resource-warnings']['get']['responses']['200']['content']['application/json']

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: true })

const WARNING_STALENESS = "interval '5 minutes'"
const WARNING_ATTRIBUTES = ['avg_cpu_usage', 'ram_usage', 'disk_fs_used', 'disk_fs_size'] as const

function level(value: number | undefined): 'critical' | 'warning' | null {
  if (value === undefined) return null
  if (value >= 90) return 'critical'
  if (value >= 80) return 'warning'
  return null
}

export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res
      .status(405)
      .json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }
  if (!IS_SELF_PLATFORM) {
    const response: ResourceWarningsResponse = []
    return res.status(200).json(response)
  }

  const gotrueId = claims?.sub
  if (!gotrueId) {
    return res.status(401).json({ message: 'Unauthorized: missing token claims' })
  }
  const ctx = await getMemberContext(gotrueId)
  // Warnings must cover EVERY visible project, not one page — pass a high limit
  // so the default 100-row page never silently truncates the fleet (an internal
  // multi-team platform can exceed 100 registered projects).
  const visible = await listAllProjectsV2(ctx, 10_000)
  let refs = visible.projects.map((p) => p.ref)
  const refFilter = typeof req.query.ref === 'string' ? req.query.ref : undefined
  if (refFilter !== undefined) refs = refs.filter((r) => r === refFilter)
  if (refs.length === 0) return res.status(200).json([])

  // One batched latest-sample query for every visible project. Attribute list
  // and staleness are in-file literals; refs are parameterized.
  const { data, error } = await executePlatformQuery<{
    project_ref: string
    attribute: string
    value: number
  }>({
    query: `select project_ref, attribute, value from (
        select project_ref, attribute, value,
               row_number() over (partition by project_ref, attribute order by sampled_at desc) as rn
        from platform.metrics_samples
        where project_ref = any(string_to_array($1, ','))
          and attribute in ('${WARNING_ATTRIBUTES.join("','")}')
          and sampled_at > now() - ${WARNING_STALENESS}
      ) t where rn = 1`,
    parameters: [refs.join(',')],
  })
  if (error) {
    return res.status(500).json({ error: { message: error.message } })
  }

  const byRef = new Map<string, Record<string, number>>()
  for (const row of data ?? []) {
    if (!byRef.has(row.project_ref)) byRef.set(row.project_ref, {})
    byRef.get(row.project_ref)![row.attribute] = Number(row.value)
  }

  const response = refs.map((ref) => {
    const v = byRef.get(ref) ?? {}
    const diskPct =
      v.disk_fs_used !== undefined && v.disk_fs_size !== undefined && v.disk_fs_size > 0
        ? (v.disk_fs_used / v.disk_fs_size) * 100
        : undefined
    return {
      project: ref,
      is_readonly_mode_enabled: false,
      cpu_exhaustion: level(v.avg_cpu_usage),
      memory_and_swap_exhaustion: level(v.ram_usage),
      disk_space_exhaustion: level(diskPct),
      disk_io_exhaustion: null,
      auth_email_offender: null,
      auth_rate_limit_exhaustion: null,
      auth_restricted_email_sending: null,
      need_pitr: null,
    }
  })
  return res.status(200).json(response as ResourceWarningsResponse)
}
