import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import { NextApiRequest, NextApiResponse } from 'next'

import apiWrapper from '@/lib/api/apiWrapper'
import { POSTGRES_PORT } from '@/lib/api/self-hosted/constants'
import { checkPermission } from '@/lib/api/self-platform/rbac/enforce'
import {
  ProjectNotFound,
  resolveProjectConnection,
} from '@/lib/api/self-platform/resolve-connection'
import {
  DEFAULT_PROJECT,
  PROJECT_DB_HOST,
  PROJECT_ENDPOINT,
  PROJECT_ENDPOINT_PROTOCOL,
  PROJECT_REST_URL,
} from '@/lib/constants/api'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

export default (req: NextApiRequest, res: NextApiResponse) => apiWrapper(req, res, handler)

// [self-platform] exported for handler-level tests
export async function handler(req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) {
  const { method } = req

  switch (method) {
    case 'GET':
      return handleGetAll(req, res, claims)
    default:
      res.setHeader('Allow', ['GET'])
      res.status(405).json({ data: null, error: { message: `Method ${method} Not Allowed` } })
  }
}

// Platform specific endpoint — plain self-hosted, byte-identical to the
// pre-M2.1 literal. Pure extraction, zero behavioral change.
function buildGlobalResponse() {
  return {
    project: {
      ...DEFAULT_PROJECT,
      api_key_supabase_encrypted: '',
      db_host: PROJECT_DB_HOST,
      db_name: 'postgres',
      db_port: POSTGRES_PORT,
      db_ssl: false,
      db_user: 'postgres',
      services: [
        {
          id: 1,
          name: 'Default API',
          app: { id: 1, name: 'Auto API' },
          app_config: {
            db_schema: 'public',
            endpoint: PROJECT_ENDPOINT,
            realtime_enabled: true,
          },
          service_api_keys: [
            {
              api_key_encrypted: '-',
              name: 'service_role key',
              tags: 'service_role',
            },
            {
              api_key_encrypted: '-',
              name: 'anon key',
              tags: 'anon',
            },
          ],
        },
      ],
    },
    autoApiService: {
      id: 1,
      name: 'Default API',
      project: { ref: 'default' },
      app: { id: 1, name: 'Auto API' },
      app_config: {
        db_schema: 'public',
        endpoint: PROJECT_ENDPOINT,
        realtime_enabled: true,
      },
      protocol: PROJECT_ENDPOINT_PROTOCOL,
      endpoint: PROJECT_ENDPOINT,
      restUrl: PROJECT_REST_URL,
      defaultApiKey: process.env.SUPABASE_ANON_KEY,
      serviceApiKey: process.env.SUPABASE_SERVICE_KEY,
      service_api_keys: [
        {
          api_key_encrypted: '-',
          name: 'service_role key',
          tags: 'service_role',
        },
        {
          api_key_encrypted: '-',
          name: 'anon key',
          tags: 'anon',
        },
      ],
    },
  }
}

const handleGetAll = async (req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) => {
  if (!IS_SELF_PLATFORM) {
    // Platform specific endpoint — plain self-hosted, byte-identical.
    return res.status(200).json(buildGlobalResponse())
  }

  // [self-platform] Per-ref values from the resolver. Endpoint follows the
  // M2 C1 convention: bare host derived from the resolved kong URL.
  try {
    const conn = await resolveProjectConnection(String(req.query.ref))
    // [self-platform] M3.0: visibility guard, then secrets masking (spec §7.3).
    const canRead = await checkPermission(claims, {
      action: PermissionAction.READ,
      resource: 'projects',
      projectRef: String(req.query.ref),
    })
    if (!canRead) return res.status(403).json({ message: 'Forbidden' })
    const canReadSecrets = await checkPermission(claims, {
      action: PermissionAction.SECRETS_READ,
      resource: 'projects',
      projectRef: String(req.query.ref),
    })
    // [self-platform] conn.supabaseUrl is only the project's public-facing
    // kong URL for a registry hit (conn.row set). For the unregistered
    // 'default' fallback, resolveProjectConnection's fromGlobalEnv() sets
    // supabaseUrl = process.env.SUPABASE_URL — the service-INTERNAL url
    // (e.g. kong:8000), which is non-empty in real deployments and must
    // NOT be used to derive the public endpoint/protocol. Only derive from
    // conn.supabaseUrl when there's an actual registry row; otherwise keep
    // the PROJECT_ENDPOINT / PROJECT_ENDPOINT_PROTOCOL globals (public host).
    let endpoint = PROJECT_ENDPOINT
    let protocol = PROJECT_ENDPOINT_PROTOCOL
    if (conn.row) {
      try {
        const u = new URL(conn.supabaseUrl)
        endpoint = u.host
        protocol = u.protocol.replace(':', '')
      } catch {
        // registry row with a somehow-malformed kong_url — keep globals.
      }
    }
    const restUrl = conn.restUrl || PROJECT_REST_URL
    const serviceApiKeys = [
      { api_key_encrypted: '-', name: 'service_role key', tags: 'service_role' },
      { api_key_encrypted: '-', name: 'anon key', tags: 'anon' },
    ]
    const appConfig = { db_schema: 'public', endpoint, realtime_enabled: true }
    return res.status(200).json({
      project: {
        id: conn.row?.id ?? DEFAULT_PROJECT.id,
        ref: conn.ref,
        name: conn.name,
        organization_id: conn.organizationId ?? DEFAULT_PROJECT.organization_id,
        cloud_provider: conn.cloudProvider,
        status: conn.status,
        region: conn.region,
        inserted_at: DEFAULT_PROJECT.inserted_at,
        api_key_supabase_encrypted: '',
        db_host: conn.dbHost,
        db_name: conn.dbName,
        db_port: conn.dbPort,
        db_ssl: false,
        db_user: conn.dbUser,
        services: [
          {
            id: 1,
            name: 'Default API',
            app: { id: 1, name: 'Auto API' },
            app_config: appConfig,
            service_api_keys: serviceApiKeys,
          },
        ],
      },
      autoApiService: {
        id: 1,
        name: 'Default API',
        project: { ref: conn.ref },
        app: { id: 1, name: 'Auto API' },
        app_config: appConfig,
        protocol,
        endpoint,
        restUrl,
        defaultApiKey: conn.anonKey,
        serviceApiKey: canReadSecrets ? conn.serviceKey : '',
        service_api_keys: serviceApiKeys,
      },
    })
  } catch (err) {
    if (err instanceof ProjectNotFound) {
      return res.status(404).json({ message: 'Project not found' })
    }
    throw err
  }
}
