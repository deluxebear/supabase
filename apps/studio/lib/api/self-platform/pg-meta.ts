import type { IncomingHttpHeaders } from 'http'

import { constructHeaders } from '../apiHelpers'
import { resolveProjectConnection } from './resolve-connection'

/**
 * Build Fleet pg-meta headers after route authorization. The browser-supplied
 * connection header is never trusted; the selected project's credential is
 * resolved and injected exclusively on the server.
 */
export async function constructFleetPgMetaHeaders(
  projectRef: string,
  incomingHeaders: IncomingHttpHeaders
) {
  const connection = await resolveProjectConnection(projectRef)
  return constructHeaders({
    ...incomingHeaders,
    'x-connection-encrypted': connection.pgConnEncrypted,
  })
}
