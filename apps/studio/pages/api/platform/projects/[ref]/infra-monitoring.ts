import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { executePlatformQuery } from '@/lib/api/self-platform/db'
import { ATTRIBUTE_META } from '@/lib/api/self-platform/metrics'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

const INTERVAL_SECONDS: Record<string, number> = {
  '1m': 60,
  '5m': 300,
  '10m': 600,
  '30m': 1800,
  '1h': 3600,
  '1d': 86400,
}

export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  const { method } = req

  switch (method) {
    case 'GET':
      return handleGetAll(req, res, claims)
    default:
      res.setHeader('Allow', ['GET'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

const handleGetAll = async (req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) => {
  if (!IS_SELF_PLATFORM) {
    // Platform specific endpoint
    const response = {
      data: [],
      yAxisLimit: 0,
      format: '%',
      total: 0,
    }
    return res.status(200).json(response)
  }

  // Param validation BEFORE the guard (400-before-403 for malformed requests;
  // guard itself resolves the ref first, keeping 404-before-403 for ghosts).
  if (Array.isArray(req.query.ref)) {
    return res.status(400).json({ error: { message: 'Invalid ref parameter' } })
  }
  const ref = String(req.query.ref)
  const rawAttributes = req.query.attributes
  const attributesParam = Array.isArray(rawAttributes) ? rawAttributes.join(',') : rawAttributes
  const attributes = (attributesParam ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter((a) => a !== '')
  if (attributes.length === 0) {
    return res.status(400).json({ error: { message: 'attributes is required' } })
  }
  const interval = typeof req.query.interval === 'string' ? req.query.interval : '1h'
  const bucketSeconds = INTERVAL_SECONDS[interval]
  if (bucketSeconds === undefined) {
    return res.status(400).json({ error: { message: `Invalid interval: ${interval}` } })
  }
  const startDate = typeof req.query.startDate === 'string' ? req.query.startDate : ''
  const endDate = typeof req.query.endDate === 'string' ? req.query.endDate : ''
  if (Number.isNaN(Date.parse(startDate)) || Number.isNaN(Date.parse(endDate))) {
    return res.status(400).json({ error: { message: 'startDate and endDate must be ISO dates' } })
  }
  // databaseIdentifier (cloud replica selector) is accepted and ignored.

  const ok = await guardProjectRoute(res, claims, {
    action: PermissionAction.ANALYTICS_READ,
    projectRef: ref,
  })
  if (!ok) return

  // Whitelist barrier: only ATTRIBUTE_META keys reach the SQL (unknown
  // attributes get zeroed series — honest empty, no 404 wall).
  const known = attributes.filter((a) => a in ATTRIBUTE_META)
  const buckets = new Map<number, Record<string, number>>()
  const perAttr = new Map<string, { last: number; sum: number; count: number }>()

  if (known.length > 0) {
    const { data, error } = await executePlatformQuery<{
      attribute: string
      bucket: number
      value: number
    }>({
      query: `select attribute,
         (floor(extract(epoch from sampled_at) / $2)::bigint * $2)::bigint as bucket,
         avg(value)::float8 as value
       from platform.metrics_samples
       where project_ref = $1
         and attribute = any(string_to_array($3, ','))
         and sampled_at >= $4::timestamptz
         and sampled_at <= $5::timestamptz
       group by 1, 2
       order by 2 asc`,
      parameters: [ref, bucketSeconds, known.join(','), startDate, endDate],
    })
    if (error) {
      return res.status(500).json({ error: { message: error.message } })
    }
    for (const row of data ?? []) {
      const bucket = Number(row.bucket)
      const value = Number(row.value)
      if (!buckets.has(bucket)) buckets.set(bucket, {})
      buckets.get(bucket)![row.attribute] = value
      const agg = perAttr.get(row.attribute) ?? { last: 0, sum: 0, count: 0 }
      agg.last = value
      agg.sum += value
      agg.count += 1
      perAttr.set(row.attribute, agg)
    }
  }

  const series: Record<
    string,
    { yAxisLimit: number; format: string; total: number; totalAverage: number }
  > = {}
  for (const attr of attributes) {
    const meta = ATTRIBUTE_META[attr]
    const agg = perAttr.get(attr)
    series[attr] = {
      format: meta?.format ?? '',
      yAxisLimit: meta?.yAxisLimit ?? 0,
      total: agg === undefined ? 0 : meta?.total === 'sum' ? agg.sum : agg.last,
      totalAverage: agg === undefined || agg.count === 0 ? 0 : agg.sum / agg.count,
    }
  }
  const data = [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([bucket, values]) => ({
      period_start: new Date(bucket * 1000).toISOString(),
      values,
    }))

  return res.status(200).json({ data, series })
}
