import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { getAdminClientForRef } from '@/lib/api/self-hosted-admin'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

const RBAC_ACTIONS: Record<string, string> = {
  GET: PermissionAction.STORAGE_ADMIN_READ,
  PATCH: PermissionAction.STORAGE_ADMIN_WRITE,
  DELETE: PermissionAction.STORAGE_ADMIN_WRITE,
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
    case 'PATCH':
      return handlePatch(req, res)
    case 'DELETE':
      return handleDelete(req, res)
    default:
      res.setHeader('Allow', ['GET', 'PATCH', 'DELETE'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

const handleGet = async (req: NextApiRequest, res: NextApiResponse) => {
  // [self-platform] Per-ref storage client (global on plain self-hosted).
  const supabase = await getAdminClientForRef(req.query.ref)
  const { id } = req.query

  const { data, error } = await supabase.storage.getBucket(id as string)
  if (error) {
    return res.status(400).json({ error: { message: error.message } })
  }

  return res.status(200).json(data)
}

const handlePatch = async (req: NextApiRequest, res: NextApiResponse) => {
  // [self-platform] Per-ref storage client (global on plain self-hosted).
  const supabase = await getAdminClientForRef(req.query.ref)
  const { id } = req.query
  const {
    public: isPublicBucket,
    allowed_mime_types: allowedMimeTypes,
    file_size_limit: fileSizeLimit,
  } = req.body

  const { data, error } = await supabase.storage.updateBucket(id as string, {
    public: isPublicBucket,
    allowedMimeTypes,
    fileSizeLimit,
  })
  if (error) {
    return res.status(400).json({ error: { message: error.message } })
  }

  return res.status(200).json(data)
}

const handleDelete = async (req: NextApiRequest, res: NextApiResponse) => {
  // [self-platform] Per-ref storage client (global on plain self-hosted).
  const supabase = await getAdminClientForRef(req.query.ref)
  const { id } = req.query

  const { data, error } = await supabase.storage.deleteBucket(id as string)
  if (error) {
    return res.status(400).json({ error: { message: error.message } })
  }

  return res.status(200).json(data)
}
