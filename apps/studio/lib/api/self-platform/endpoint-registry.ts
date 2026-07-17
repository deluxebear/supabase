import { z } from 'zod'

import { executePlatformQuery } from './db'

const tlsModeSchema = z.enum(['disable', 'prefer', 'require', 'verify-ca', 'verify-full'])

const postgresEndpointSchema = z.object({
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535),
  database: z.string().trim().min(1),
  user: z.string().trim().min(1),
  tlsMode: tlsModeSchema,
})

const supavisorEndpointSchema = z.object({
  host: z.string().trim().min(1),
  transactionPort: z.number().int().min(1).max(65535),
  sessionPort: z.number().int().min(1).max(65535),
  database: z.string().trim().min(1),
  user: z.string().trim().min(1),
  tenantId: z.string().trim().min(1),
  tlsMode: tlsModeSchema,
})

export const publicProjectEndpointsSchema = z.object({
  apiUrl: z.string().url(),
  restUrl: z.string().url(),
  authUrl: z.string().url(),
  storageUrl: z.string().url(),
  realtimeUrl: z.string().url(),
  functionsUrl: z.string().url(),
  s3Url: z.string().url(),
  directPostgres: postgresEndpointSchema,
  supavisor: supavisorEndpointSchema,
})

export type PublicProjectEndpoints = z.infer<typeof publicProjectEndpointsSchema>

export type ProjectEndpointRegistry = {
  revision: number
  endpoints: PublicProjectEndpoints
}

export function isRegisteredFunctionUrl(
  requestUrl: string,
  registeredFunctionsUrl: string
): boolean {
  try {
    const request = new URL(requestUrl)
    const registered = new URL(registeredFunctionsUrl)
    const registeredPath = registered.pathname.replace(/\/+$/, '')
    const relativePath = request.pathname.slice(registeredPath.length + 1)
    const hasHttpProtocol =
      (request.protocol === 'http:' || request.protocol === 'https:') &&
      (registered.protocol === 'http:' || registered.protocol === 'https:')

    return (
      hasHttpProtocol &&
      request.username === '' &&
      request.password === '' &&
      registered.username === '' &&
      registered.password === '' &&
      registered.search === '' &&
      registered.hash === '' &&
      request.hash === '' &&
      request.origin === registered.origin &&
      registeredPath.length > 0 &&
      request.pathname.startsWith(`${registeredPath}/`) &&
      relativePath.length > 0 &&
      !relativePath.startsWith('/')
    )
  } catch {
    return false
  }
}

export function publicProjectEndpointsFromDocument(
  document: unknown
): PublicProjectEndpoints | null {
  const parsed = z
    .object({ public: publicProjectEndpointsSchema.optional() })
    .passthrough()
    .safeParse(document)
  return parsed.success && parsed.data.public ? parsed.data.public : null
}

export function safeLegacyPublicUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return isDockerOnlyHost(url.hostname) ? null : url.toString()
  } catch {
    return null
  }
}

export class EndpointRevisionConflict extends Error {
  constructor() {
    super('The project connection revision changed; reload the endpoint registry and retry.')
  }
}

export class EndpointRegistryMissing extends Error {
  constructor(projectRef: string) {
    super(`Public endpoints are not configured for project ${projectRef}.`)
  }
}

function isDockerOnlyHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return (
    host === 'localhost' ||
    host.endsWith('.internal') ||
    (!host.includes('.') && !host.includes(':'))
  )
}

export function validatePublicProjectEndpoints(input: unknown): PublicProjectEndpoints {
  const endpoints = publicProjectEndpointsSchema.parse(input)
  for (const value of [
    endpoints.apiUrl,
    endpoints.restUrl,
    endpoints.authUrl,
    endpoints.storageUrl,
    endpoints.realtimeUrl,
    endpoints.functionsUrl,
    endpoints.s3Url,
  ]) {
    if (isDockerOnlyHost(new URL(value).hostname)) {
      throw new Error('Public endpoint URLs must not use Docker-only hostnames.')
    }
  }
  if (
    isDockerOnlyHost(endpoints.directPostgres.host) ||
    isDockerOnlyHost(endpoints.supavisor.host)
  ) {
    throw new Error('Public database endpoints must not use Docker-only hostnames.')
  }
  return endpoints
}

export async function getProjectEndpointRegistry(
  projectRef: string
): Promise<ProjectEndpointRegistry | null> {
  const result = await executePlatformQuery<{
    active_connection_revision: number
    endpoint_document: unknown
  }>({
    query: `select b.active_connection_revision, r.endpoint_document
      from platform.stack_bindings b
      join platform.project_connection_revisions r
        on r.project_ref = b.project_ref and r.revision = b.active_connection_revision
      where b.project_ref = $1 and b.attachment_state <> 'detached'`,
    parameters: [projectRef],
  })
  if (result.error) throw result.error
  const row = result.data?.[0]
  if (!row) return null
  const endpoints = publicProjectEndpointsFromDocument(row.endpoint_document)
  if (!endpoints) return null
  return { revision: row.active_connection_revision, endpoints }
}

export async function findProjectEndpointRegistryForFunctionUrl(
  functionUrl: string
): Promise<ProjectEndpointRegistry | null> {
  try {
    const parsed = new URL(functionUrl)
    if (
      (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.hash !== ''
    ) {
      return null
    }
  } catch {
    return null
  }

  const result = await executePlatformQuery<{
    active_connection_revision: number
    endpoint_document: unknown
  }>({
    query: `select b.active_connection_revision, r.endpoint_document
      from platform.stack_bindings b
      join platform.project_connection_revisions r
        on r.project_ref = b.project_ref and r.revision = b.active_connection_revision
      where b.attachment_state <> 'detached'
        and strpos($1, r.endpoint_document->'public'->>'functionsUrl') = 1`,
    parameters: [functionUrl],
  })
  if (result.error) throw result.error

  for (const row of result.data ?? []) {
    const endpoints = publicProjectEndpointsFromDocument(row.endpoint_document)
    if (endpoints && isRegisteredFunctionUrl(functionUrl, endpoints.functionsUrl)) {
      return { revision: row.active_connection_revision, endpoints }
    }
  }

  return null
}

export async function requireProjectEndpointRegistry(
  projectRef: string
): Promise<ProjectEndpointRegistry> {
  const registry = await getProjectEndpointRegistry(projectRef)
  if (!registry) throw new EndpointRegistryMissing(projectRef)
  return registry
}

export async function updateProjectEndpointRegistry(input: {
  projectRef: string
  expectedRevision: number
  endpoints: PublicProjectEndpoints
  actor: string
  correlationId: string
}): Promise<ProjectEndpointRegistry> {
  const endpoints = validatePublicProjectEndpoints(input.endpoints)
  const result = await executePlatformQuery<{ revision: number }>({
    query: `with current as (
        select b.active_connection_revision, r.id, r.key_mode, r.connection_document,
               r.endpoint_document, r.stack_fingerprint, r.preflight_report,
               r.validated_at, r.activated_at
        from platform.stack_bindings b
        join platform.project_connection_revisions r
          on r.project_ref = b.project_ref and r.revision = b.active_connection_revision
        where b.project_ref = $1 and b.attachment_state = 'active'
          and b.active_connection_revision = $2
        for update of b, r
      ), previous as (
        update platform.project_connection_revisions r
        set state = 'rollback', rollback_until = now() + interval '24 hours'
        where r.id = (select id from current) and r.state = 'active'
        returning r.project_ref
      ), next_revision as (
        select coalesce(max(r.revision), 0) + 1 as revision
        from platform.project_connection_revisions r
        where r.project_ref = $1 and exists (select 1 from previous)
      ), inserted as (
        insert into platform.project_connection_revisions (
          project_ref, revision, state, key_mode, connection_document, endpoint_document,
          stack_fingerprint, preflight_report, created_by, correlation_id,
          validated_at, activated_at
        )
        select $1, next_revision.revision, 'active', current.key_mode,
               current.connection_document,
               jsonb_build_object(
                 'contractVersion', 'v1',
                 'internal', coalesce(current.endpoint_document->'internal', '{}'::jsonb),
                 'public', $3::jsonb
               ),
               current.stack_fingerprint, current.preflight_report, $4, $5,
               coalesce(current.validated_at, now()), now()
        from current cross join next_revision
        returning revision, endpoint_document
      ), binding as (
        update platform.stack_bindings b
        set active_connection_revision = inserted.revision, status_observed_at = now()
        from inserted where b.project_ref = $1
      ), project as (
        update platform.projects p
        set endpoint_document = inserted.endpoint_document, updated_at = now()
        from inserted where p.ref = $1
      ), audit as (
        insert into platform.audit_events (actor, project_ref, action, correlation_id, payload)
        select $4, $1, 'fleet.project.endpoints.update', $5,
               jsonb_build_object('previous_revision', $2, 'connection_revision', inserted.revision)
        from inserted
      )
      select revision from inserted`,
    parameters: [
      input.projectRef,
      input.expectedRevision,
      JSON.stringify(endpoints),
      input.actor,
      input.correlationId,
    ],
  })
  if (result.error) throw result.error
  const revision = result.data?.[0]?.revision
  if (!revision) throw new EndpointRevisionConflict()
  return { revision, endpoints }
}
