import { components } from 'api-types'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { mintServiceJwt } from '@/lib/api/self-platform/mint-jwt'
import {
  ProjectNotFound,
  resolveProjectConnection,
} from '@/lib/api/self-platform/resolve-connection'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

type ProjectAppConfig = components['schemas']['ProjectSettingsResponse']['app_config'] & {
  protocol?: string
}
export type ProjectSettings = components['schemas']['ProjectSettingsResponse'] & {
  app_config?: ProjectAppConfig
}

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

const ALLOWED_ROLES = new Set(['anon', 'authenticated', 'service_role'])
const DEFAULT_EXP_SECONDS = 300
const MIN_EXP_SECONDS = 60
const MAX_EXP_SECONDS = 3600

// [self-platform] exported for handler-level tests
export async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req

  switch (method) {
    case 'POST':
      return handlePost(req, res)
    default:
      res.setHeader('Allow', ['POST'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

const handlePost = async (req: NextApiRequest, res: NextApiResponse) => {
  if (!IS_SELF_PLATFORM) {
    // Plain self-hosted: historical behavior, byte-identical.
    const response = {
      api_key: process.env.SUPABASE_SERVICE_KEY ?? '',
    }
    return res.status(200).json(response)
  }

  // [self-platform] Cloud-faithful semantics: mint a short-lived HS256 JWT
  // signed with the resolved project's secret instead of handing out the
  // permanent service key.
  let role = 'service_role'
  const rawClaims = req.query.claims
  if (rawClaims !== undefined) {
    if (Array.isArray(rawClaims)) {
      return res.status(400).json({ message: 'Invalid claims parameter' })
    }
    try {
      const parsed = JSON.parse(rawClaims)
      if (typeof parsed?.role === 'string') role = parsed.role
    } catch {
      return res.status(400).json({ message: 'Invalid claims parameter' })
    }
  }
  if (!ALLOWED_ROLES.has(role)) {
    return res.status(400).json({ message: `Role not allowed: ${role}` })
  }

  let expiresIn = DEFAULT_EXP_SECONDS
  const rawExp = req.query.authorization_exp
  if (rawExp !== undefined) {
    if (Array.isArray(rawExp) || !/^\d+$/.test(rawExp)) {
      return res.status(400).json({ message: 'Invalid authorization_exp parameter' })
    }
    expiresIn = Math.min(MAX_EXP_SECONDS, Math.max(MIN_EXP_SECONDS, parseInt(rawExp, 10)))
  }

  try {
    const conn = await resolveProjectConnection(String(req.query.ref))
    if (!conn.jwtSecret) {
      // Fail closed — never fall back to returning a permanent key.
      return res.status(500).json({ message: 'JWT secret is not configured for this project' })
    }
    return res.status(200).json({ api_key: mintServiceJwt(conn.jwtSecret, role, expiresIn) })
  } catch (err) {
    if (err instanceof ProjectNotFound) {
      return res.status(404).json({ message: 'Project not found' })
    }
    throw err
  }
}
