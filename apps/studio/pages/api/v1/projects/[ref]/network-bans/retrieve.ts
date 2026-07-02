// [self-platform] Contract-minimal stub: self-platform has no network-ban
// tracking (M1) — no IP has ever been auto-banned, so the list is always
// empty. Typed against api-types so upstream contract changes surface at
// compile time.
import type { paths } from 'api-types'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'

type NetworkBansResponse =
  paths['/v1/projects/{ref}/network-bans/retrieve']['post']['responses']['201']['content']['application/json']

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: true })

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', ['POST'])
    return res
      .status(405)
      .json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }
  const response: NetworkBansResponse = { banned_ipv4_addresses: [] }
  return res.status(201).json(response)
}
