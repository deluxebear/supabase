import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import { paths } from 'api-types'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { getFolders, getSnippets } from '@/lib/api/snippets.utils'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

const wrappedHandler = (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

const RBAC_ACTIONS: Record<string, string> = {
  GET: PermissionAction.READ,
  PATCH: PermissionAction.UPDATE,
}

// [self-platform] exported for handler-level tests
export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  const { method } = req

  // [self-platform] M3.0 RBAC guard (spec §7.3). 404-before-403 lives inside
  // guardProjectRoute (resolver-first) — a behavior change here: this route
  // previously ignored `ref` entirely.
  if (IS_SELF_PLATFORM) {
    const action = RBAC_ACTIONS[method ?? '']
    if (action) {
      const ok = await guardProjectRoute(res, claims, {
        action,
        resource: 'user_content',
        projectRef: String(req.query.ref),
      })
      if (!ok) return
    }
  }

  switch (method) {
    case 'GET':
      return handleGetAll(req, res)
    case 'PATCH':
      return handlePatch(req, res)
    default:
      res.setHeader('Allow', ['GET', 'PATCH'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

type GetRequestData =
  paths['/platform/projects/{ref}/content/folders/{id}']['get']['parameters']['query']
type GetResponseData =
  paths['/platform/projects/{ref}/content/folders/{id}']['get']['responses']['200']['content']['application/json']

const handleGetAll = async (req: NextApiRequest, res: NextApiResponse<GetResponseData>) => {
  const params = req.query as GetRequestData
  const folderId = (req.query.id as string) ?? null

  const folders = await getFolders(folderId)
  // Folder listings return metadata only (no SQL body) to match the Management API contract; the
  // editor loads each snippet's content on demand via the item endpoint.
  const { cursor, snippets } = await getSnippets({
    searchTerm: params?.name,
    cursor: params?.cursor,
    folderId: folderId,
    limit: params?.limit ? Number(params.limit) : undefined,
    sort: params?.sort_by,
    sortOrder: params?.sort_order,
    includeContent: false,
  })

  return res.status(200).json({ data: { folders: folders, contents: snippets }, cursor })
}

type PatchResponseData =
  paths['/platform/projects/{ref}/content/folders/{id}']['patch']['responses']['200']['content']

const handlePatch = async (_req: NextApiRequest, res: NextApiResponse<PatchResponseData>) => {
  // Platform specific endpoint
  return res.status(200).json({} as never)
}

export default wrappedHandler
