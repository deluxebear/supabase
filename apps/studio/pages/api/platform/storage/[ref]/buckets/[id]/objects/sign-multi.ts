import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { getAdminContextForRef } from '@/lib/api/self-hosted-admin'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

const wrappedHandler = (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

const RBAC_ACTIONS: Record<string, string> = {
  POST: PermissionAction.STORAGE_READ,
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
    case 'POST':
      return handlePost(req, res)
    default:
      res.setHeader('Allow', ['POST'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

const handlePost = async (req: NextApiRequest, res: NextApiResponse) => {
  // [self-platform] Per-ref storage client + public base URL (global on plain self-hosted).
  const { client: supabase, publicBaseUrl } = await getAdminContextForRef(req.query.ref)
  const { id } = req.query
  const { path, expiresIn = 60 * 60 * 24 } = req.body

  const { data, error } = await supabase.storage
    .from(id as string)
    .createSignedUrls(path, expiresIn)

  if (error) {
    return res.status(400).json({ error: { message: error.message } })
  }

  // change the domain name to the client-reachable base URL since the
  // service-internal URL is not accessible from the client
  const parsed = new URL(publicBaseUrl)
  const remapped = (data ?? []).map((item) => {
    if (!item.signedUrl) return item
    const signedUrl = new URL(item.signedUrl)
    signedUrl.protocol = parsed.protocol
    signedUrl.host = parsed.host
    signedUrl.port = parsed.port
    return { ...item, signedUrl: signedUrl.href }
  })

  return res.status(201).json(remapped)
}

export default wrappedHandler
