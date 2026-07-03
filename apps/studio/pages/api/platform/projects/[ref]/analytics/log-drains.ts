import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { AnalyticsNotConfigured, getAnalyticsTarget } from '@/lib/api/self-hosted/logs'
import { ProjectNotFound } from '@/lib/api/self-platform/resolve-connection'
import { PROJECT_ANALYTICS_URL } from '@/lib/constants/api'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

export async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { method } = req

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
      // list log drains
      const url = new URL(baseUrl)
      url.pathname = '/api/backends'
      url.search = new URLSearchParams({
        'metadata[type]': 'log-drain',
      }).toString()
      const upstream = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      })

      if (!upstream.ok) {
        return res
          .status(500)
          .json({ error: { message: 'Failed to fetch log drains from upstream' } })
      }

      const resp = await upstream.json()

      if (!Array.isArray(resp)) {
        return res
          .status(500)
          .json({ error: { message: 'Unexpected response format from upstream' } })
      }

      return res.status(200).json(resp)
    case 'POST':
      // create the log drain
      const postUrl = new URL(baseUrl)
      postUrl.pathname = '/api/backends'
      const postResult = await fetch(postUrl, {
        body: JSON.stringify({
          ...req.body,
          config: req.body.config,
          metadata: {
            type: 'log-drain',
          },
        }),
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      }).then(async (r) => await r.json())

      const sourcesGetUrl = new URL(baseUrl)
      sourcesGetUrl.pathname = '/api/sources'
      const sources = await fetch(sourcesGetUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      }).then((r) => r.json())

      const params = sources
        .filter((source: { name: string; metadata: { type: string } }) =>
          [
            'cloudflare.logs.prod',
            'deno-relay-logs',
            'deno-subhosting-events',
            'gotrue.logs.prod',
            'pgbouncer.logs.prod',
            'postgrest.logs.prod',
            'postgres.logs',
            'realtime.logs.prod',
            'storage.logs.prod.2',
          ].includes(source.name.toLocaleLowerCase())
        )
        .map((source: { name: string; id: number }) => {
          return { backend_id: postResult.id, lql_string: `~".*?"`, source_id: source.id }
        })
      const rulesPostUrl = new URL(baseUrl)
      rulesPostUrl.pathname = '/api/rules'
      await Promise.all(
        params.map((param: any) =>
          fetch(rulesPostUrl, {
            method: 'POST',
            body: JSON.stringify(param),
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
              Accept: 'application/json',
            },
          })
        )
      )
      return res.status(201).json(postResult)

    default:
      res.setHeader('Allow', ['GET', 'POST', 'PUT', 'DELETE'])
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
