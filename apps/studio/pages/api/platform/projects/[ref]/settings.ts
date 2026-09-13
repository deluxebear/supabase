import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { JwtPayload } from '@supabase/supabase-js'
import { components } from 'api-types'
import { NextApiRequest, NextApiResponse } from 'next'

import { apiWrapper } from '@/lib/api/apiWrapper'
import { getProjectSettings } from '@/lib/api/self-hosted/settings'
import { publicProjectEndpointsFromDocument } from '@/lib/api/self-platform/endpoint-registry'
import { checkPermission } from '@/lib/api/self-platform/rbac/enforce'
import {
  ProjectNotFound,
  resolveProjectConnection,
} from '@/lib/api/self-platform/resolve-connection'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

type ProjectAppConfig = components['schemas']['ProjectSettingsResponse_Output']['app_config'] & {
  protocol?: string
}
export type ProjectSettings = components['schemas']['ProjectSettingsResponse_Output'] & {
  app_config?: ProjectAppConfig
}

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

const handleGetAll = async (req: NextApiRequest, res: NextApiResponse, claims?: JwtPayload) => {
  // [self-platform] Resolve the registry project by ref so multi-project
  // deployments return the right connection/keys. Plain self-hosted keeps
  // the historical global-env path (getProjectSettings() with no arg).
  if (!IS_SELF_PLATFORM) {
    const response = getProjectSettings()
    return res.status(200).json(response)
  }

  try {
    const conn = await resolveProjectConnection(String(req.query.ref))
    // [self-platform] M3.0: visibility guard, then secrets masking (spec §7.3).
    const canRead = await checkPermission(claims, {
      action: PermissionAction.READ,
      resource: 'projects',
      projectRef: String(req.query.ref),
    })
    if (!canRead) return res.status(403).json({ message: 'Forbidden' })

    const endpoints = publicProjectEndpointsFromDocument(conn.row?.endpoint_document)
    if (!endpoints) {
      return res.status(409).json({
        code: 'endpoint_registry_unconfigured',
        message: `Public endpoints are not configured for project ${conn.ref}.`,
      })
    }
    const apiUrl = new URL(endpoints.apiUrl)
    const settings = {
      ...getProjectSettings(conn),
      app_config: {
        db_schema: 'public',
        endpoint: apiUrl.host,
        storage_endpoint: apiUrl.host,
        protocol: apiUrl.protocol.replace(':', ''),
      },
      db_host: endpoints.directPostgres.host,
      db_port: endpoints.directPostgres.port,
      db_name: endpoints.directPostgres.database,
      db_user: endpoints.directPostgres.user,
      ssl_enforced: endpoints.directPostgres.tlsMode !== 'disable',
    }
    const canReadSecrets = await checkPermission(claims, {
      action: PermissionAction.SECRETS_READ,
      resource: 'projects',
      projectRef: String(req.query.ref),
    })
    const response = canReadSecrets
      ? settings
      : {
          ...settings,
          jwt_secret: '',
          service_api_keys: settings.service_api_keys.filter((key) => key.tags !== 'service_role'),
        }
    return res.status(200).json(response)
  } catch (err) {
    if (err instanceof ProjectNotFound) {
      return res.status(404).json({ message: 'Project not found' })
    }
    throw err
  }
}
