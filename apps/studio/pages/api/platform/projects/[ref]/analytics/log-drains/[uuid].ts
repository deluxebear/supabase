import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import {
  ANALYTICS_TIMEOUT_MS,
  AnalyticsNotConfigured,
  getAnalyticsTarget,
} from '@/lib/api/self-hosted/logs'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { ProjectNotFound } from '@/lib/api/self-platform/resolve-connection'
import { PROJECT_ANALYTICS_URL } from '@/lib/constants/api'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

const RBAC_ACTIONS: Record<string, string> = {
  GET: PermissionAction.ANALYTICS_ADMIN_READ,
  PUT: PermissionAction.ANALYTICS_ADMIN_WRITE,
  DELETE: PermissionAction.ANALYTICS_ADMIN_WRITE,
}

export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  const { method } = req
  const { uuid } = req.query

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

  // [self-platform] Per-ref Logflare target; plain self-hosted keeps the
  // byte-identical env-check path below.
  let baseUrl: string
  let token: string
  if (IS_SELF_PLATFORM) {
    try {
      const target = await getAnalyticsTarget(req.query.ref)
      baseUrl = target.baseUrl
      token = target.token
    } catch (err) {
      if (err instanceof ProjectNotFound) {
        return res.status(404).json({ message: 'Project not found' })
      }
      if (err instanceof AnalyticsNotConfigured) {
        return res.status(404).json({ message: 'Analytics is not configured for this project' })
      }
      // [self-platform] Unregistered-default fallback with missing LOGFLARE_*
      // env throws AssertionError from getAnalyticsTarget — surface the
      // descriptive message like the plain-self-hosted branch does, not a
      // bare error object.
      if (err instanceof Error && err.name === 'AssertionError') {
        return res.status(500).json({ error: { message: err.message } })
      }
      throw err
    }
  } else {
    const missingEnvVars = envVarsSet()
    if (missingEnvVars !== true) {
      return res
        .status(500)
        .json({ error: { message: `${missingEnvVars.join(', ')} env variables are not set` } })
    }
    if (!PROJECT_ANALYTICS_URL) {
      return res.status(500).json({ error: { message: `LOGFLARE_URL env variable is not set` } })
    }
    baseUrl = PROJECT_ANALYTICS_URL
    token = process.env.LOGFLARE_PRIVATE_ACCESS_TOKEN!
  }

  switch (method) {
    case 'GET':
      // get log drain
      const url = new URL(baseUrl)
      url.pathname = `/api/backends/${uuid}`
      const result = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(ANALYTICS_TIMEOUT_MS),
      }).then((r) => r.json())

      return res.status(200).json(result)
    case 'PUT':
      // create the log drain
      const putUrl = new URL(baseUrl)
      putUrl.pathname = `/api/backends/${uuid}`
      delete req.body['metadata']
      const putResult = await fetch(putUrl, {
        body: JSON.stringify(req.body),
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(ANALYTICS_TIMEOUT_MS),
      })
        .then(async (r) => await r.json())
        .catch((err) => {
          console.error('error updating log drain', err)
          return res.status(500).json({ error: { message: 'Error updating log drain' } })
        })
      return res.status(200).json(putResult)

    case 'DELETE':
      // create the log drain
      const deleteUrl = new URL(baseUrl)
      deleteUrl.pathname = `/api/backends/${uuid}`

      await fetch(deleteUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        method: 'DELETE',
        signal: AbortSignal.timeout(ANALYTICS_TIMEOUT_MS),
      }).catch((err) => {
        console.error('error deleting log drain', err)
        return res.status(500).json({ error: { message: 'Error deleting log drain' } })
      })
      return res.status(204).json({ error: null })
    default:
      res.setHeader('Allow', ['GET', 'POST'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

const envVarsSet = () => {
  const missingEnvVars = [
    process.env.LOGFLARE_PRIVATE_ACCESS_TOKEN ? null : 'LOGFLARE_PRIVATE_ACCESS_TOKEN',
    process.env.LOGFLARE_URL ? null : 'LOGFLARE_URL',
  ].filter((v) => v)
  if (missingEnvVars.length == 0) {
    return true
  } else {
    return missingEnvVars
  }
}
