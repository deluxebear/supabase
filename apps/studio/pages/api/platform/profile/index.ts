import type { JwtPayload } from '@supabase/supabase-js'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import {
  createProfileWithDefaultMembership,
  getProfileByGotrueId,
  toProfileResponse,
} from '@/lib/api/self-platform/profiles'
import { DEFAULT_PROJECT } from '@/lib/constants/api'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

export default (req: NextApiRequest, res: NextApiResponse) =>
  apiWrapper(req, res, handler, { withAuth: true })

// [self-platform] exported for handler-level tests
export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  if (!IS_SELF_PLATFORM) return legacyHandler(req, res)

  const gotrueId = claims?.sub
  const email = (claims as { email?: string } | undefined)?.email
  if (!gotrueId || !email) {
    return res.status(401).json({ message: 'Unauthorized: missing token claims' })
  }

  switch (req.method) {
    case 'GET': {
      const row = await getProfileByGotrueId(gotrueId)
      if (!row) return res.status(404).json({ message: "User's profile not found" })
      return res.status(200).json(toProfileResponse(row))
    }
    case 'POST': {
      const row = await createProfileWithDefaultMembership({ gotrueId, email })
      return res.status(201).json(toProfileResponse(row))
    }
    default:
      res.setHeader('Allow', ['GET', 'POST'])
      return res
        .status(405)
        .json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }
}

// Plain self-hosted keeps the historical stub payload untouched.
async function legacyHandler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', ['GET'])
    return res
      .status(405)
      .json({ data: null, error: { message: `Method ${req.method} Not Allowed` } })
  }
  const response = {
    id: 1,
    primary_email: 'johndoe@supabase.io',
    username: 'johndoe',
    first_name: 'John',
    last_name: 'Doe',
    organizations: [
      {
        id: 1,
        name: process.env.DEFAULT_ORGANIZATION_NAME || 'Default Organization',
        slug: 'default-org-slug',
        billing_email: 'billing@supabase.co',
        projects: [{ ...DEFAULT_PROJECT, connectionString: '' }],
      },
    ],
  }
  return res.status(200).json(response)
}
