import type { JwtPayload } from '@supabase/supabase-js'
import type { components } from 'api-types'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import {
  ProjectNotFound,
  resolveProjectConnection,
} from '@/lib/api/self-platform/resolve-connection'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

type StorageConfigResponse = components['schemas']['StorageConfigResponse']

// [self-platform] Storage config is shared-stack-level: the self-hosted storage
// service reads its limits/features from env at boot, so the management plane
// can't model per-project overrides. We surface the stack defaults on GET (so the
// Storage settings page renders instead of erroring on a 404) and treat PATCH as
// a no-op echo — the same contract as the PostgREST config endpoint.
//
// The global upload size limit is env-overridable (STORAGE_FILE_SIZE_LIMIT, in
// bytes); default 50 MiB. imageTransformation (imgproxy) and s3Protocol are both
// part of the default self-hosted storage stack, so they default to enabled.
const DEFAULT_FILE_SIZE_LIMIT = 52428800 // 50 MiB

const buildStorageConfig = (): StorageConfigResponse => {
  const fileSizeLimit = Number(process.env.STORAGE_FILE_SIZE_LIMIT ?? DEFAULT_FILE_SIZE_LIMIT)

  return {
    fileSizeLimit: Number.isFinite(fileSizeLimit) ? fileSizeLimit : DEFAULT_FILE_SIZE_LIMIT,
    features: {
      imageTransformation: { enabled: process.env.STORAGE_IMGPROXY_ENABLED !== 'false' },
      s3Protocol: { enabled: process.env.STORAGE_S3_PROTOCOL_ENABLED !== 'false' },
      icebergCatalog: { enabled: false, maxCatalogs: 0, maxNamespaces: 0, maxTables: 0 },
      vectorBuckets: { enabled: false, maxBuckets: 0, maxIndexes: 0 },
    },
    capabilities: { iceberg_catalog: false, list_v2: false },
    databasePoolMode: '',
    external: { upstreamTarget: 'main' },
    migrationVersion: '',
  }
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

  return res.status(200).json(buildStorageConfig())
}

const handlePatch = async (req: NextApiRequest, res: NextApiResponse) => {
  // No-op: stack-level storage config can't be persisted per-project from the
  // management plane. Echo the submitted values merged over the defaults so the
  // form reflects the request without erroring.
  const config = buildStorageConfig()
  const body = typeof req.body === 'object' && req.body !== null ? req.body : {}
  return res.status(200).json({
    ...config,
    ...body,
    features: { ...config.features, ...(body as Partial<StorageConfigResponse>).features },
  })
}
