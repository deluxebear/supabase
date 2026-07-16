import type { IncomingHttpHeaders } from 'http'

import { constructHeaders } from '../apiHelpers'
import type { ResolvedConnection } from './resolve-connection'
import { resolveProjectConnection } from './resolve-connection'

export type FleetPgMetaRequest = {
  baseUrl: string
  headers: ReturnType<typeof constructHeaders>
}

export function getProjectPgMetaBaseUrl(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/$/, '')}/pg`
}

export function constructProjectPgMetaRequest(
  connection: Pick<
    ResolvedConnection,
    'supabaseUrl' | 'serviceKey' | 'pgConnEncrypted' | 'pgConnReadOnlyEncrypted'
  >,
  incomingHeaders: IncomingHttpHeaders | HeadersInit = {},
  { readOnly = false }: { readOnly?: boolean } = {}
): FleetPgMetaRequest {
  const serviceAuthorization = `Bearer ${connection.serviceKey}`
  const headers = constructHeaders({
    ...incomingHeaders,
    Authorization: serviceAuthorization,
    'Content-Type': 'application/json',
    'x-connection-encrypted': readOnly
      ? connection.pgConnReadOnlyEncrypted
      : connection.pgConnEncrypted,
  })

  return {
    baseUrl: getProjectPgMetaBaseUrl(connection.supabaseUrl),
    headers: {
      ...headers,
      Authorization: serviceAuthorization,
      apiKey: connection.serviceKey,
    },
  }
}

/**
 * Build Fleet pg-meta headers after route authorization. The browser-supplied
 * connection header is never trusted; the selected project's credential is
 * resolved and injected exclusively on the server.
 */
export async function resolveFleetPgMetaRequest(
  projectRef: string,
  incomingHeaders: IncomingHttpHeaders,
  options?: { readOnly?: boolean }
): Promise<FleetPgMetaRequest> {
  const connection = await resolveProjectConnection(projectRef)
  return constructProjectPgMetaRequest(connection, incomingHeaders, options)
}
