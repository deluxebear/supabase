import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import type { components } from 'api-types'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import {
  ProjectNotFound,
  resolveProjectConnection,
} from '@/lib/api/self-platform/resolve-connection'
import {
  mergeStoredServiceConfig,
  readStoredServiceConfig,
} from '@/lib/api/self-platform/service-settings'
import {
  parseStoredStorageOverrides,
  storageUpdateSchema,
  toStoredStorageOverrides,
} from '@/lib/api/self-platform/storage-config'
import { STUDIO_DEPLOYMENT_PROFILE } from '@/lib/constants/deployment-profile'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

type StorageConfigResponse = components['schemas']['StorageConfigResponse_Output']

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
      purgeCache: { enabled: process.env.STORAGE_IMGPROXY_PURGE !== 'false' },
      s3Protocol: { enabled: process.env.STORAGE_S3_PROTOCOL_ENABLED !== 'false' },
      icebergCatalog: { enabled: false, maxCatalogs: 0, maxNamespaces: 0, maxTables: 0 },
      vectorBuckets: { enabled: false, maxBuckets: 0, maxIndexes: 0 },
    },
    capabilities: { iceberg_catalog: false, list_v2: false, object_versioning: false },
    external: { upstreamTarget: 'main' },
    migrationVersion: '',
  }
}

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  const { method } = req

  switch (method) {
    case 'GET':
      return handleGet(req, res)
    case 'PATCH':
      return handlePatch(req, res, claims)
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

  const config = buildStorageConfig()
  if (!isFleet()) return res.status(200).json(config)
  // [self-platform] Fleet: stored overrides are the desired settings.
  const stored = parseStoredStorageOverrides(
    await readStoredServiceConfig(String(req.query.ref), 'storage')
  )
  return res.status(200).json(withOverrides(config, stored))
}

const isFleet = () => IS_SELF_PLATFORM && STUDIO_DEPLOYMENT_PROFILE === 'fleet'

function withOverrides(
  config: StorageConfigResponse,
  stored: ReturnType<typeof parseStoredStorageOverrides>
): StorageConfigResponse {
  return {
    ...config,
    fileSizeLimit: stored.fileSizeLimit ?? config.fileSizeLimit,
    features: {
      ...config.features,
      imageTransformation: {
        ...config.features.imageTransformation,
        enabled: stored.imageTransformationEnabled ?? config.features.imageTransformation.enabled,
      },
    },
  }
}

const handlePatch = async (req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) => {
  if (isFleet()) return handleFleetPatch(req, res, claims)
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

// [self-platform] Fleet only: stores the settings Storage reads from its
// environment as desired state. They reach the running service when applied
// through config/storage/apply, which recreates the service.
const handleFleetPatch = async (req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) => {
  const projectRef = String(req.query.ref)
  const allowed = await guardProjectRoute(res, claims, {
    action: PermissionAction.STORAGE_ADMIN_WRITE,
    projectRef,
  })
  if (!allowed) return
  const parsed = storageUpdateSchema.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ message: 'Invalid Storage settings' })
  const stored = await mergeStoredServiceConfig({
    projectRef,
    service: 'storage',
    patch: toStoredStorageOverrides(parsed.data),
    actor: claims?.sub ?? 'unknown',
  })
  return res
    .status(200)
    .json(withOverrides(buildStorageConfig(), parseStoredStorageOverrides(stored)))
}
