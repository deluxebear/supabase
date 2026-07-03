import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { getAdminClientForRef } from '@/lib/api/self-hosted-admin'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

// eslint-disable-next-line import/no-anonymous-default-export
export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

const RBAC_ACTIONS: Record<string, string> = {
  GET: PermissionAction.STORAGE_ADMIN_READ,
  POST: PermissionAction.STORAGE_ADMIN_WRITE,
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
      return handleGet(req, res)
    case 'POST':
      return handlePost(req, res)

    default:
      res.setHeader('Allow', ['GET', 'POST'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

const handleGet = async (req: NextApiRequest, res: NextApiResponse) => {
  // [self-platform] Per-ref storage client (global on plain self-hosted).
  const supabase = await getAdminClientForRef(req.query.ref)
  const { id } = req.query

  const { data, error } = await supabase.storage.vectors
    .from(id as string)
    .listIndexes({ maxResults: 100 })

  if (error) return res.status(500).json({ error: { message: error.message } })

  const indexes = await Promise.all(
    data.indexes.map(async ({ indexName }) => {
      return (await supabase.storage.vectors.from(id as string).getIndex(indexName)).data?.index
    })
  )

  return res.status(200).json({ indexes, nextToken: data.nextToken })
}

const handlePost = async (req: NextApiRequest, res: NextApiResponse) => {
  // [self-platform] Per-ref storage client (global on plain self-hosted).
  const supabase = await getAdminClientForRef(req.query.ref)
  const { id } = req.query
  const { indexName, dataType, dimension, distanceMetric, metadataKeys } = req.body
  const payload = {
    indexName,
    dataType,
    dimension,
    distanceMetric,
    metadataConfiguration: { nonFilterableMetadataKeys: metadataKeys },
  }

  const { data, error } = await supabase.storage.vectors.from(id as string).createIndex(payload)
  if (error) return res.status(400).json({ error: { message: error.message } })
  return res.status(200).json(data)
}
