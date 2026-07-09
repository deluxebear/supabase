import type { JwtPayload } from '@supabase/supabase-js'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import {
  ProjectNotFound,
  resolveProjectConnection,
} from '@/lib/api/self-platform/resolve-connection'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

// [self-platform] Realtime limits are shared-stack-level config: the self-hosted
// realtime service reads them from its own env at boot, so the management plane
// can't model per-project overrides. We surface the stack defaults on GET (so the
// Realtime settings page renders instead of erroring on a 404) and treat PATCH as
// a no-op echo (persisting would require restarting the realtime service) — the
// same contract as the PostgREST config endpoint (config/index.ts).
const REALTIME_DEFAULT_CONFIG = {
  private_only: false,
  connection_pool: 2,
  max_concurrent_users: 200,
  max_events_per_second: 100,
  max_bytes_per_second: 100000,
  max_channels_per_client: 100,
  max_joins_per_second: 100,
  max_presence_events_per_second: 100,
  max_payload_size_in_kb: 100,
  suspend: false,
}

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

export async function handler(req: NextApiRequest, res: NextApiResponse, _claims?: JwtPayload) {
  const { method } = req

  switch (method) {
    case 'GET':
      return handleGet(req, res)
    case 'PATCH':
      return handlePatch(req, res)
    default:
      res.setHeader('Allow', ['GET', 'PATCH'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

const handleGet = async (req: NextApiRequest, res: NextApiResponse) => {
  // Resolve first so an unknown ref 404s (mirrors config/index.ts: 404 before data).
  if (IS_SELF_PLATFORM) {
    try {
      await resolveProjectConnection(String(req.query.ref))
    } catch (err) {
      if (err instanceof ProjectNotFound) {
        return res.status(404).json({ message: 'Project not found' })
      }
      throw err
    }
  }

  return res.status(200).json(REALTIME_DEFAULT_CONFIG)
}

const handlePatch = async (req: NextApiRequest, res: NextApiResponse) => {
  // No-op: stack-level realtime config can't be persisted per-project from the
  // management plane. Echo the submitted values merged over the defaults so the
  // form reflects the request without erroring.
  const body = typeof req.body === 'object' && req.body !== null ? req.body : {}
  return res.status(200).json({ ...REALTIME_DEFAULT_CONFIG, ...body })
}
