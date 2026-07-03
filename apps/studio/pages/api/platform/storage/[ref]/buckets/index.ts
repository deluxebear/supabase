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
  const { limit, offset, search, sortColumn, sortOrder } = parseStoragePaginationParams(req)

  const { data, error } = await supabase.storage.listBuckets({
    ...(limit ? { limit } : {}),
    ...(offset ? { offset } : {}),
    ...(search ? { search } : {}),
    ...(sortColumn ? { sortColumn } : {}),
    ...(sortOrder ? { sortOrder } : {}),
  })
  if (error) {
    return res.status(500).json({ error: { message: 'Internal Server Error' } })
  }

  return res.status(200).json(data)
}

const handlePost = async (req: NextApiRequest, res: NextApiResponse) => {
  // [self-platform] Per-ref storage client (global on plain self-hosted).
  const supabase = await getAdminClientForRef(req.query.ref)
  const {
    id,
    public: isPublicBucket,
    allowed_mime_types: allowedMimeTypes,
    file_size_limit: fileSizeLimit,
  } = req.body

  const { data, error } = await supabase.storage.createBucket(id, {
    public: isPublicBucket,
    allowedMimeTypes,
    fileSizeLimit,
  })
  if (error) {
    return res.status(400).json({ error: { message: error.message } })
  }

  return res.status(200).json(data)
}

const parseStoragePaginationParams = (req: NextApiRequest) => {
  const {
    limit: queryLimit,
    offset: queryOffset,
    search: querySearch,
    sortColumn: querySortColumn,
    sortOrder: querySortOrder,
  } = req.query

  const limit = parseAsInt(queryLimit)
  const offset = parseAsInt(queryOffset)
  const search = parseAsString(querySearch)
  const sortColumn = parseAsStringEnum(querySortColumn, ['id', 'created_at', 'name'])
  const sortOrder = parseAsStringEnum(querySortOrder, ['asc', 'desc'])

  return { limit, offset, search, sortColumn, sortOrder }
}

const parseAsInt = (value: string | string[] | undefined): number | undefined =>
  value ? (Array.isArray(value) ? parseInt(value[0], 10) : parseInt(value, 10)) : undefined

const parseAsString = (value: string | string[] | undefined): string | undefined =>
  value ? (Array.isArray(value) ? value[0] : value) : undefined

const parseAsStringEnum = <T extends string>(
  value: string | string[] | undefined,
  validValues: T[]
): T | undefined => {
  const strValue = value ? (Array.isArray(value) ? value[0] : value) : undefined
  return strValue && validValues.includes(strValue as T) ? (strValue as T) : undefined
}
