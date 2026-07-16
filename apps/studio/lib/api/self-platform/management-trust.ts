import { createHmac, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import https from 'node:https'
import path from 'node:path'
import { z } from 'zod'

import { executePlatformQuery } from './db'

const MANAGEMENT_REQUEST_TIMEOUT_MS = 10_000
const MANAGEMENT_RESPONSE_LIMIT_BYTES = 1 << 20
const ASSERTION_REFERENCE_PATTERN = /^env:(FLEET_MANAGEMENT_ASSERTION_[A-Z0-9_]+)$/
const CA_ENV_REFERENCE_PATTERN = /^env:(FLEET_MANAGEMENT_CA_[A-Z0-9_]+)$/
const MANAGEMENT_CA_DIRECTORY = '/run/secrets/fleet-management'

export const managementDomainSchema = z.object({
  domain: z.enum(['fleet-control', 'backup-operator']),
  apiUrl: z
    .string()
    .url()
    .refine((value) => value.startsWith('https://'), 'apiUrl must use HTTPS'),
  audience: z.string().min(1).max(128),
  contractVersion: z.string().min(1).max(32),
  capabilitySchemaPrefix: z.string().regex(/^supabase\.[a-z][a-z0-9.-]*\.$/),
  targetVersion: z.string().nullable().default(null),
  state: z
    .enum(['unverified', 'available', 'unavailable', 'incompatible', 'revoked'])
    .default('unverified'),
  observedAt: z.string().datetime({ offset: true }).nullable().default(null),
})

export const managementTargetInputSchema = z.object({
  name: z.string().trim().min(1).max(64),
  trustDomain: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9.-]{0,252}[a-z0-9]$/),
  caReference: z
    .string()
    .trim()
    .refine(
      (value) =>
        CA_ENV_REFERENCE_PATTERN.test(value) ||
        value.startsWith(`file:${MANAGEMENT_CA_DIRECTORY}/`),
      `caReference must use an allowed env: reference or ${MANAGEMENT_CA_DIRECTORY}`
    ),
  assertionKeyReference: z.string().trim().regex(ASSERTION_REFERENCE_PATTERN),
  domains: z
    .array(
      managementDomainSchema.pick({
        domain: true,
        apiUrl: true,
        audience: true,
        contractVersion: true,
        capabilitySchemaPrefix: true,
      })
    )
    .min(1)
    .max(2)
    .superRefine((domains, ctx) => {
      const names = new Set(domains.map((domain) => domain.domain))
      if (names.size !== domains.length) {
        ctx.addIssue({ code: 'custom', message: 'Management target domains must be unique' })
      }
      if (!names.has('fleet-control')) {
        ctx.addIssue({ code: 'custom', message: 'A Fleet Control domain is required' })
      }
    }),
})

export type ManagementTargetInput = z.infer<typeof managementTargetInputSchema>

export const managementTargetSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.number().int().positive(),
  name: z.string(),
  trustDomain: z.string(),
  caReference: z.string(),
  assertionKeyReference: z.string(),
  state: z.enum(['active', 'disabled', 'revoked']),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  domains: z.array(managementDomainSchema),
})

export type ManagementTarget = z.infer<typeof managementTargetSchema>

export const managementBindingInputSchema = z.object({
  managementTargetId: z.string().uuid(),
  executionTarget: z.string().trim().min(1).max(255),
  deploymentKind: z.enum(['compose', 'kubernetes', 'systemd', 'bare-metal']),
  allowedCapabilityPrefixes: z
    .array(z.string().regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*\.$/))
    .min(1)
    .max(32)
    .refine(
      (values) => new Set(values).size === values.length,
      'Capability prefixes must be unique'
    )
    .refine(
      (values) => values.every((value) => !value.startsWith('management.')),
      'The management capability namespace is reserved by the platform'
    ),
})

export type ManagementBindingInput = z.infer<typeof managementBindingInputSchema>

export const projectedCapabilitySchema = z.object({
  domain: z.string(),
  name: z.string(),
  contractVersion: z.string(),
  inputSchema: z.string(),
  evidenceSchema: z.string(),
  observedAt: z.string().datetime({ offset: true }),
  state: z.enum(['available', 'unavailable', 'unauthorized', 'stale', 'unsupported']),
  mode: z.enum(['operator', 'agent', 'kubernetes-job', 'unsupported']),
  source: z.literal('agent'),
  blockers: z.array(
    z.object({
      code: z.string().min(1),
      message: z.string().min(1),
      remediation: z.string().optional(),
    })
  ),
})

export const managementBindingSchema = z.object({
  id: z.string().uuid(),
  projectRef: z.string(),
  organizationId: z.number().int().positive(),
  managementTargetId: z.string().uuid(),
  managementTargetName: z.string(),
  trustDomain: z.string(),
  executionTarget: z.string(),
  deploymentKind: z.enum(['compose', 'kubernetes', 'systemd', 'bare-metal']),
  allowedCapabilityPrefixes: z.array(z.string()),
  state: z.enum([
    'pending',
    'enrolling',
    'active',
    'offline',
    'incompatible',
    'revoking',
    'revoked',
  ]),
  agentId: z.string().nullable(),
  protocolMajor: z.number().int().nullable(),
  protocolMinor: z.number().int().nullable(),
  agentBuild: z.string().nullable(),
  activeCertificateRevision: z.number().int().positive().nullable(),
  certificateExpiresAt: z.string().datetime({ offset: true }).nullable(),
  lastSeenAt: z.string().datetime({ offset: true }).nullable(),
  observationRevision: z.string().nullable(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  targetState: z.enum(['active', 'disabled', 'revoked']),
  domains: z.array(managementDomainSchema),
})

export type ManagementBinding = z.infer<typeof managementBindingSchema>

const fleetBindingStatusSchema = z.object({
  binding: z.object({
    bindingId: z.string(),
    organizationId: z.string(),
    projectRef: z.string(),
    targetId: z.string(),
    executionTarget: z.string(),
    deploymentKind: z.enum(['compose', 'kubernetes', 'systemd', 'bare-metal']),
    allowedCapabilityPrefixes: z.array(z.string()),
    state: z.enum(['pending', 'enrolling', 'active', 'revoked', 'incompatible']),
    createdAt: z.string().datetime({ offset: true }),
    updatedAt: z.string().datetime({ offset: true }),
  }),
  agent: z
    .object({
      id: z.string(),
      bindingId: z.string(),
      state: z.enum(['online', 'offline', 'revoked', 'replaced', 'incompatible']),
      protocolMajor: z.number().int(),
      protocolMinor: z.number().int(),
      build: z.string(),
      activeCertificateRevision: z.number().int().positive(),
      certificateExpiresAt: z.string().datetime({ offset: true }),
      lastSeenAt: z.string().datetime({ offset: true }),
      capabilities: z.array(z.unknown()).default([]),
    })
    .nullable(),
  capabilities: z.array(projectedCapabilitySchema).default([]),
})

const enrollmentTokenResponseSchema = z.object({
  id: z.string(),
  bindingId: z.string().uuid(),
  token: z.string().min(32),
  expiresAt: z.string().datetime({ offset: true }),
})

export type EnrollmentTokenResponse = z.infer<typeof enrollmentTokenResponseSchema>

export const enrollmentTokenAuditQuery = `with binding as (
  update platform.project_management_bindings set state = 'enrolling', updated_at = now()
  where id = $1 and project_ref = $2 and state in ('pending', 'enrolling', 'offline', 'incompatible')
  returning id
), audit as (
  insert into platform.audit_events (actor, project_ref, action, correlation_id, payload)
  select $3, $2, 'fleet.enrollment_token.issue', $4,
         jsonb_build_object('binding_id', id, 'enrollment_id', $5::text,
                            'expires_at', $6::timestamptz)
  from binding
) select id from binding`

type ManagementTargetRow = {
  id: string
  organization_id: number
  name: string
  trust_domain: string
  ca_reference: string
  assertion_key_reference: string
  state: ManagementTarget['state']
  created_at: string
  updated_at: string
  domains: unknown
}

type ManagementBindingRow = {
  id: string
  project_ref: string
  organization_id: number
  management_target_id: string
  management_target_name: string
  trust_domain: string
  execution_target: string
  deployment_kind: ManagementBinding['deploymentKind']
  allowed_capability_prefixes: unknown
  state: ManagementBinding['state']
  agent_id: string | null
  protocol_major: number | null
  protocol_minor: number | null
  agent_build: string | null
  active_certificate_revision: number | null
  certificate_expires_at: string | null
  last_seen_at: string | null
  observation_revision: string | null
  created_at: string
  updated_at: string
  target_state: ManagementBinding['targetState']
  domains: unknown
}

const targetSelect = `
select t.id, t.organization_id, t.name, t.trust_domain, t.ca_reference,
       t.assertion_key_reference, t.state, t.created_at, t.updated_at,
       coalesce(jsonb_agg(jsonb_build_object(
         'domain', d.domain, 'apiUrl', d.api_url, 'audience', d.audience,
         'contractVersion', d.contract_version,
         'capabilitySchemaPrefix', d.capability_schema_prefix,
         'targetVersion', d.target_version, 'state', d.state, 'observedAt', d.observed_at
       ) order by d.domain) filter (where d.domain is not null), '[]'::jsonb) as domains
from platform.management_targets t
left join platform.management_target_domains d on d.management_target_id = t.id`

// pg-meta returns timestamptz values using PostgreSQL's text representation
// (`YYYY-MM-DD HH:mm:ss.us+00`). Normalize at the database boundary before the
// public schemas enforce ISO 8601. Downstream Fleet APIs already return ISO.
function normalizeDatabaseTimestamp(value: string): string {
  const timestamp = new Date(value)
  return Number.isNaN(timestamp.getTime()) ? value : timestamp.toISOString()
}

function normalizeNullableDatabaseTimestamp(value: string | null): string | null {
  return value === null ? null : normalizeDatabaseTimestamp(value)
}

function normalizeDomainTimestamps(value: unknown): unknown {
  if (!Array.isArray(value)) return value
  return value.map((domain) => {
    if (domain === null || typeof domain !== 'object') return domain
    const record = domain as Record<string, unknown>
    return {
      ...record,
      observedAt:
        typeof record.observedAt === 'string'
          ? normalizeDatabaseTimestamp(record.observedAt)
          : record.observedAt,
    }
  })
}

function mapTarget(row: ManagementTargetRow): ManagementTarget {
  return managementTargetSchema.parse({
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    trustDomain: row.trust_domain,
    caReference: row.ca_reference,
    assertionKeyReference: row.assertion_key_reference,
    state: row.state,
    createdAt: normalizeDatabaseTimestamp(row.created_at),
    updatedAt: normalizeDatabaseTimestamp(row.updated_at),
    domains: normalizeDomainTimestamps(row.domains),
  })
}

export async function listManagementTargets(organizationId: number): Promise<ManagementTarget[]> {
  const result = await executePlatformQuery<ManagementTargetRow>({
    query: `${targetSelect}
      where t.organization_id = $1
      group by t.id order by t.name`,
    parameters: [organizationId],
  })
  if (result.error) throw result.error
  return (result.data ?? []).map(mapTarget)
}

export async function getManagementTarget(
  organizationId: number,
  targetId: string
): Promise<ManagementTarget | null> {
  const result = await executePlatformQuery<ManagementTargetRow>({
    query: `${targetSelect}
      where t.organization_id = $1 and t.id = $2
      group by t.id`,
    parameters: [organizationId, targetId],
  })
  if (result.error) throw result.error
  return result.data?.[0] ? mapTarget(result.data[0]) : null
}

export async function createManagementTarget(input: {
  organizationId: number
  target: ManagementTargetInput
  actor: string
  correlationId?: string
}): Promise<ManagementTarget> {
  const target = managementTargetInputSchema.parse(input.target)
  const correlationId = input.correlationId ?? randomUUID()
  const result = await executePlatformQuery<{ id: string }>({
    query: `with inserted_target as (
      insert into platform.management_targets (
        organization_id, name, trust_domain, ca_reference,
        assertion_key_reference, created_by, correlation_id
      ) values ($1, $2, $3, $4, $5, $6, $7)
      returning id
    ), inserted_domains as (
      insert into platform.management_target_domains (
        management_target_id, domain, api_url, audience,
        contract_version, capability_schema_prefix
      )
      select inserted_target.id, domain.domain, domain.api_url, domain.audience,
             domain.contract_version, domain.capability_schema_prefix
      from inserted_target
      cross join jsonb_to_recordset($8::jsonb) as domain(
        domain text, api_url text, audience text,
        contract_version text, capability_schema_prefix text
      )
      returning management_target_id
    ), audit as (
      insert into platform.audit_events (actor, project_ref, action, correlation_id, payload)
      select $6, 'organization:' || $1::text, 'fleet.management_target.create', $7,
             jsonb_build_object('management_target_id', inserted_target.id,
                                'trust_domain', $3,
                                'domains', (select jsonb_agg(domain) from inserted_domains domain))
      from inserted_target
    ) select id from inserted_target`,
    parameters: [
      input.organizationId,
      target.name,
      target.trustDomain,
      target.caReference,
      target.assertionKeyReference,
      input.actor,
      correlationId,
      JSON.stringify(
        target.domains.map((domain) => ({
          domain: domain.domain,
          api_url: domain.apiUrl,
          audience: domain.audience,
          contract_version: domain.contractVersion,
          capability_schema_prefix: domain.capabilitySchemaPrefix,
        }))
      ),
    ],
  })
  if (result.error) throw result.error
  const id = result.data?.[0]?.id
  if (!id) throw new Error('Management target insert returned no identity')
  const created = await getManagementTarget(input.organizationId, id)
  if (!created) throw new Error('Management target disappeared after creation')
  return created
}

export async function revokeManagementTarget(input: {
  organizationId: number
  targetId: string
  actor: string
  correlationId?: string
}): Promise<void> {
  const result = await executePlatformQuery<{ id: string }>({
    query: `with revoked as (
      update platform.management_targets target set
        state = 'revoked', revoked_at = now(), updated_at = now()
      where target.id = $1 and target.organization_id = $2 and target.state <> 'revoked'
        and not exists (
          select 1 from platform.project_management_bindings binding
          where binding.management_target_id = target.id and binding.state <> 'revoked'
        )
      returning id
    ), revoked_domains as (
      update platform.management_target_domains set state = 'revoked', updated_at = now()
      where management_target_id in (select id from revoked)
    ), audit as (
      insert into platform.audit_events (actor, project_ref, action, correlation_id, payload)
      select $3, 'organization:' || $2::text, 'fleet.management_target.revoke', $4,
             jsonb_build_object('management_target_id', id)
      from revoked
    ) select id from revoked`,
    parameters: [
      input.targetId,
      input.organizationId,
      input.actor,
      input.correlationId ?? randomUUID(),
    ],
  })
  if (result.error) throw result.error
  if (!result.data?.[0]) {
    throw new ManagementTrustConflict(
      'management_target_in_use',
      'Revoke every project binding before revoking this management target.'
    )
  }
}

const bindingSelect = `
select b.id, b.project_ref, p.organization_id, b.management_target_id,
       t.name as management_target_name, t.trust_domain,
       b.execution_target, b.deployment_kind, b.allowed_capability_prefixes,
       b.state, b.agent_id, b.protocol_major, b.protocol_minor, b.agent_build,
       b.active_certificate_revision, b.certificate_expires_at, b.last_seen_at,
       b.observation_revision, b.created_at, b.updated_at, t.state as target_state,
       coalesce(jsonb_agg(jsonb_build_object(
         'domain', d.domain, 'apiUrl', d.api_url, 'audience', d.audience,
         'contractVersion', d.contract_version,
         'capabilitySchemaPrefix', d.capability_schema_prefix,
         'targetVersion', d.target_version, 'state', d.state, 'observedAt', d.observed_at
       ) order by d.domain) filter (where d.domain is not null), '[]'::jsonb) as domains
from platform.project_management_bindings b
join platform.projects p on p.ref = b.project_ref
join platform.management_targets t on t.id = b.management_target_id
left join platform.management_target_domains d on d.management_target_id = t.id`

function mapBinding(row: ManagementBindingRow): ManagementBinding {
  return managementBindingSchema.parse({
    id: row.id,
    projectRef: row.project_ref,
    organizationId: row.organization_id,
    managementTargetId: row.management_target_id,
    managementTargetName: row.management_target_name,
    trustDomain: row.trust_domain,
    executionTarget: row.execution_target,
    deploymentKind: row.deployment_kind,
    allowedCapabilityPrefixes: row.allowed_capability_prefixes,
    state: row.state,
    agentId: row.agent_id,
    protocolMajor: row.protocol_major,
    protocolMinor: row.protocol_minor,
    agentBuild: row.agent_build,
    activeCertificateRevision: row.active_certificate_revision,
    certificateExpiresAt: normalizeNullableDatabaseTimestamp(row.certificate_expires_at),
    lastSeenAt: normalizeNullableDatabaseTimestamp(row.last_seen_at),
    observationRevision: row.observation_revision,
    createdAt: normalizeDatabaseTimestamp(row.created_at),
    updatedAt: normalizeDatabaseTimestamp(row.updated_at),
    targetState: row.target_state,
    domains: normalizeDomainTimestamps(row.domains),
  })
}

export async function getProjectManagementBinding(
  projectRef: string
): Promise<ManagementBinding | null> {
  const result = await executePlatformQuery<ManagementBindingRow>({
    query: `${bindingSelect}
      where b.project_ref = $1 and b.state <> 'revoked'
      group by b.id, p.organization_id, t.id`,
    parameters: [projectRef],
  })
  if (result.error) throw result.error
  return result.data?.[0] ? mapBinding(result.data[0]) : null
}

export async function bindProjectManagementTarget(input: {
  projectRef: string
  binding: ManagementBindingInput
  actor: string
  correlationId?: string
}): Promise<ManagementBinding> {
  const binding = managementBindingInputSchema.parse(input.binding)
  const result = await executePlatformQuery<{ binding_id: string }>({
    query: `select platform.bind_management_target($1, $2, $3, $4, $5::jsonb, $6, $7) as binding_id`,
    parameters: [
      input.projectRef,
      binding.managementTargetId,
      binding.executionTarget,
      binding.deploymentKind,
      JSON.stringify(binding.allowedCapabilityPrefixes),
      input.actor,
      input.correlationId ?? randomUUID(),
    ],
  })
  if (result.error) throw result.error
  if (!result.data?.[0]?.binding_id)
    throw new Error('Management binding insert returned no identity')
  const created = await getProjectManagementBinding(input.projectRef)
  if (!created || created.id !== result.data[0].binding_id) {
    throw new Error('Management binding disappeared after creation')
  }
  return created
}

export async function issueProjectEnrollmentToken(input: {
  projectRef: string
  actor: string
  correlationId?: string
}): Promise<EnrollmentTokenResponse> {
  const binding = await getProjectManagementBinding(input.projectRef)
  if (!binding || binding.state === 'revoked' || binding.targetState !== 'active') {
    throw new ManagementTrustConflict(
      'management_target_unbound',
      'Bind an active management target first.'
    )
  }
  const correlationId = input.correlationId ?? randomUUID()
  const response = await requestManagementDomain(binding, 'fleet-control', {
    method: 'POST',
    path: `/platform/fleet/v1/projects/${encodeURIComponent(binding.projectRef)}/management-bindings/${encodeURIComponent(binding.id)}/enrollment-tokens`,
    body: {
      organizationId: String(binding.organizationId),
      targetId: binding.managementTargetId,
      executionTarget: binding.executionTarget,
      deploymentKind: binding.deploymentKind,
      allowedCapabilityPrefixes: binding.allowedCapabilityPrefixes,
    },
    scopes: ['fleet.enrollment.write'],
    actor: input.actor,
    correlationId,
  })
  const token = enrollmentTokenResponseSchema.parse(response)
  const updated = await executePlatformQuery({
    query: enrollmentTokenAuditQuery,
    parameters: [
      binding.id,
      input.projectRef,
      input.actor,
      correlationId,
      token.id,
      token.expiresAt,
    ],
  })
  if (updated.error) throw updated.error
  return token
}

export async function syncProjectManagementBinding(input: {
  projectRef: string
  actor: string
  correlationId?: string
}): Promise<ManagementBinding> {
  const binding = await getProjectManagementBinding(input.projectRef)
  if (!binding)
    throw new ManagementTrustConflict(
      'management_target_unbound',
      'Project has no management binding.'
    )
  const correlationId = input.correlationId ?? randomUUID()
  const raw = await requestManagementDomain(binding, 'fleet-control', {
    method: 'GET',
    path: `/platform/fleet/v1/projects/${encodeURIComponent(binding.projectRef)}/management-bindings/${encodeURIComponent(binding.id)}`,
    scopes: ['fleet.read'],
    actor: input.actor,
    correlationId,
  })
  const observed = fleetBindingStatusSchema.parse(raw)
  if (
    observed.binding.bindingId !== binding.id ||
    observed.binding.projectRef !== binding.projectRef ||
    observed.binding.organizationId !== String(binding.organizationId) ||
    observed.binding.targetId !== binding.managementTargetId
  ) {
    throw new ManagementTrustConflict(
      'binding_mismatch',
      'Fleet Control returned evidence for a different management binding.'
    )
  }
  const agent = observed.agent
  const observationRevision = agent
    ? `${agent.id}:${agent.activeCertificateRevision}:${Date.parse(agent.lastSeenAt)}`
    : `binding:${binding.id}:${observed.binding.state}`
  const validUntil = agent ? new Date(Date.parse(agent.lastSeenAt) + 30_000).toISOString() : null
  const platformState: ManagementBinding['state'] = !agent
    ? observed.binding.state === 'incompatible'
      ? 'incompatible'
      : 'enrolling'
    : agent.state === 'online'
      ? 'active'
      : agent.state === 'incompatible'
        ? 'incompatible'
        : 'offline'
  const result = await executePlatformQuery({
    query: `with updated_binding as (
      update platform.project_management_bindings set
        state = $3, agent_id = $4, protocol_major = $5, protocol_minor = $6,
        agent_build = $7, active_certificate_revision = $8,
        certificate_expires_at = $9, last_seen_at = $10,
        observation_revision = $11, updated_at = now()
      where id = $1 and project_ref = $2 and state <> 'revoked'
      returning id
    ), updated_stack as (
      update platform.stack_bindings set
        management_connectivity = case $3
          when 'active' then 'online'
          when 'incompatible' then 'incompatible'
          else 'offline'
        end,
        status_observed_at = now()
      where project_ref = $2 and management_binding_id = $1
    ), agent_capability as (
      insert into platform.project_capabilities (
        project_ref, name, state, mode, source, contract_version, target_version,
        observation_revision, observed_at, valid_until, blockers
      ) values (
        $2, 'management.agent.connect',
        case when $4::text is null then 'unavailable' else 'available' end,
        'agent', 'agent', 'v1', $7, $11, coalesce($10::timestamptz, now()), $12,
        case when $4::text is null
          then '[{"code":"agent_not_enrolled","message":"Issue a single-use enrollment token and enroll an Agent."}]'::jsonb
          else '[]'::jsonb end
      ) on conflict (project_ref, name) do update set
        state = excluded.state, mode = excluded.mode, source = excluded.source,
        contract_version = excluded.contract_version, target_version = excluded.target_version,
        observation_revision = excluded.observation_revision, observed_at = excluded.observed_at,
        valid_until = excluded.valid_until, blockers = excluded.blockers
    ), revoke_capability as (
      insert into platform.project_capabilities (
        project_ref, name, state, mode, source, contract_version, target_version,
        observation_revision, observed_at, valid_until, blockers
      ) values (
        $2, 'management.certificate.revoke',
        case when $4::text is null then 'unavailable' else 'available' end,
        'operator', 'operator', 'v1', $7, $11, coalesce($10::timestamptz, now()), $12,
        case when $4::text is null
          then '[{"code":"agent_not_enrolled","message":"Enroll an Agent before revoking its certificate."}]'::jsonb
          else '[]'::jsonb end
      ) on conflict (project_ref, name) do update set
        state = excluded.state, mode = excluded.mode, source = excluded.source,
        contract_version = excluded.contract_version, target_version = excluded.target_version,
        observation_revision = excluded.observation_revision, observed_at = excluded.observed_at,
        valid_until = excluded.valid_until, blockers = excluded.blockers
    ), projected as (
      insert into platform.project_capabilities (
        project_ref, name, state, mode, source, contract_version, target_version,
        observation_revision, observed_at, valid_until, blockers
      )
      select $2, capability.name, capability.state, capability.mode, 'agent',
             capability.contract_version, $7, $11, capability.observed_at, $12,
             capability.blockers
      from jsonb_to_recordset($13::jsonb) as capability(
        name text, state text, mode text, contract_version text,
        observed_at timestamptz, blockers jsonb
      )
      where capability.name not like 'management.%'
      on conflict (project_ref, name) do update set
        state = excluded.state, mode = excluded.mode, source = excluded.source,
        contract_version = excluded.contract_version, target_version = excluded.target_version,
        observation_revision = excluded.observation_revision, observed_at = excluded.observed_at,
        valid_until = excluded.valid_until, blockers = excluded.blockers
      where platform.project_capabilities.source in ('agent', 'operator')
        and excluded.name not like 'management.%'
    ), audit as (
      insert into platform.audit_events (actor, project_ref, action, correlation_id, payload)
      select $14, $2, 'fleet.management_binding.observe', $15,
             jsonb_build_object('binding_id', $1, 'state', $3,
                                'agent_id', $4, 'observation_revision', $11)
      from updated_binding
    ) select id from updated_binding`,
    parameters: [
      binding.id,
      binding.projectRef,
      platformState,
      agent?.id ?? null,
      agent?.protocolMajor ?? null,
      agent?.protocolMinor ?? null,
      agent?.build ?? null,
      agent?.activeCertificateRevision ?? null,
      agent?.certificateExpiresAt ?? null,
      agent?.lastSeenAt ?? null,
      observationRevision,
      validUntil,
      JSON.stringify(
        observed.capabilities.map((capability) => ({
          name: capability.name,
          state: capability.state,
          mode: capability.mode,
          contract_version: capability.contractVersion,
          observed_at: capability.observedAt,
          blockers: capability.blockers,
        }))
      ),
      input.actor,
      correlationId,
    ],
  })
  if (result.error) throw result.error
  const synced = await getProjectManagementBinding(input.projectRef)
  if (!synced) throw new Error('Management binding disappeared after observation')
  return synced
}

export async function revokeProjectManagementBinding(input: {
  projectRef: string
  actor: string
  correlationId?: string
}): Promise<{ bindingId: string; targetRevoked: boolean; targetCleanupPending: boolean }> {
  const binding = await getProjectManagementBinding(input.projectRef)
  if (!binding)
    throw new ManagementTrustConflict(
      'management_target_unbound',
      'Project has no management binding.'
    )
  const correlationId = input.correlationId ?? randomUUID()
  let targetRevoked = false
  try {
    await requestManagementDomain(binding, 'fleet-control', {
      method: 'POST',
      path: `/platform/fleet/v1/projects/${encodeURIComponent(binding.projectRef)}/management-bindings/${encodeURIComponent(binding.id)}/revoke`,
      scopes: ['fleet.enrollment.write'],
      actor: input.actor,
      correlationId,
      idempotencyKey: `management-binding-revoke:${binding.id}`,
    })
    targetRevoked = true
  } catch (error) {
    if (!(error instanceof ManagementTrustDownstreamError)) throw error
  }
  const result = await executePlatformQuery({
    query: `select platform.revoke_management_binding($1, $2, $3, $4, $5)`,
    parameters: [input.projectRef, binding.id, input.actor, correlationId, targetRevoked],
  })
  if (result.error) throw result.error
  return { bindingId: binding.id, targetRevoked, targetCleanupPending: !targetRevoked }
}

export class ManagementTrustConflict extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'ManagementTrustConflict'
  }
}

export class ManagementTrustDownstreamError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details: unknown = {}
  ) {
    super(message)
    this.name = 'ManagementTrustDownstreamError'
  }
}

type ManagementDomainRequest = {
  method: 'GET' | 'POST' | 'PUT'
  path: string
  body?: unknown
  contentType?: string
  headers?: Record<string, string>
  scopes: string[]
  actor: string
  correlationId: string
  projectId?: string
  aal?: string
  aalAuthenticatedAt?: number
  idempotencyKey?: string
  responseType?: 'json' | 'text' | 'buffer'
  maxResponseBytes?: number
}

export async function requestManagementDomain(
  binding: ManagementBinding,
  domainName: 'fleet-control' | 'backup-operator',
  request: ManagementDomainRequest
): Promise<unknown> {
  const domain = binding.domains.find((item) => item.domain === domainName)
  if (!domain || domain.state === 'revoked' || binding.targetState !== 'active') {
    throw new ManagementTrustConflict(
      'management_domain_unavailable',
      `Management target domain ${domainName} is unavailable.`
    )
  }
  const [assertionKey, ca] = await Promise.all([
    resolveAssertionKey(binding.managementTargetId, binding),
    resolveCAReference(binding),
  ])
  const assertion = mintManagementServiceAssertion({
    key: assertionKey,
    issuer: 'studio-platform',
    audience: domain.audience,
    subject: request.actor,
    projectRef: request.projectId ?? binding.projectRef,
    scopes: request.scopes,
    organizationId: String(binding.organizationId),
    bindingId: binding.id,
    requestId: request.correlationId,
    aal: request.aal,
    aalAuthenticatedAt: request.aalAuthenticatedAt,
  })
  try {
    const response = await httpsRequestJSON(
      new URL(request.path, ensureTrailingSlash(domain.apiUrl)),
      {
        method: request.method,
        body: request.body,
        ca,
        headers: {
          ...(request.headers ?? {}),
          Authorization: `Bearer ${assertion}`,
          'X-Correlation-ID': request.correlationId,
          'X-Audit-Context': JSON.stringify({
            actor: request.actor,
            aal: request.aal ?? 'unknown',
            organizationId: binding.organizationId,
            projectRef: binding.projectRef,
            targetId: binding.managementTargetId,
            bindingId: binding.id,
          }),
          ...(request.idempotencyKey ? { 'Idempotency-Key': request.idempotencyKey } : {}),
        },
        contentType: request.contentType,
        responseType: request.responseType,
        maxResponseBytes: request.maxResponseBytes,
      }
    )
    await recordManagementDomainObservation(binding.managementTargetId, domainName, 'available')
    return response
  } catch (error) {
    await recordManagementDomainObservation(
      binding.managementTargetId,
      domainName,
      error instanceof ManagementTrustDownstreamError && error.status === 426
        ? 'incompatible'
        : 'unavailable'
    )
    throw error
  }
}

async function recordManagementDomainObservation(
  targetId: string,
  domain: 'fleet-control' | 'backup-operator',
  state: 'available' | 'unavailable' | 'incompatible'
) {
  const result = await executePlatformQuery({
    query: `update platform.management_target_domains set
      state = $3, observed_at = now(), updated_at = now()
    where management_target_id = $1 and domain = $2 and state <> 'revoked'`,
    parameters: [targetId, domain, state],
  })
  if (result.error) throw result.error
}

async function resolveAssertionKey(_targetId: string, binding: ManagementBinding): Promise<string> {
  const target = await getManagementTarget(binding.organizationId, binding.managementTargetId)
  if (!target)
    throw new ManagementTrustConflict(
      'management_target_unavailable',
      'Management target was not found.'
    )
  const match = ASSERTION_REFERENCE_PATTERN.exec(target.assertionKeyReference)
  if (!match) throw new Error('Management target assertion key reference is invalid')
  const value = process.env[match[1]]
  if (!value || Buffer.byteLength(value) < 32) {
    throw new ManagementTrustConflict(
      'management_secret_unavailable',
      `Management assertion key reference ${target.assertionKeyReference} is unavailable.`
    )
  }
  return value
}

async function resolveCAReference(binding: ManagementBinding): Promise<string> {
  const target = await getManagementTarget(binding.organizationId, binding.managementTargetId)
  if (!target)
    throw new ManagementTrustConflict(
      'management_target_unavailable',
      'Management target was not found.'
    )
  const envMatch = CA_ENV_REFERENCE_PATTERN.exec(target.caReference)
  if (envMatch) {
    const value = process.env[envMatch[1]]
    if (!value)
      throw new ManagementTrustConflict(
        'management_ca_unavailable',
        'Management target CA is unavailable.'
      )
    return value
  }
  if (!target.caReference.startsWith('file:'))
    throw new Error('Management target CA reference is invalid')
  const requestedPath = path.resolve(target.caReference.slice('file:'.length))
  if (!requestedPath.startsWith(`${MANAGEMENT_CA_DIRECTORY}/`)) {
    throw new Error('Management target CA reference is outside the allowed secret directory')
  }
  return readFile(requestedPath, 'utf8')
}

export function mintManagementServiceAssertion(input: {
  key: string
  issuer: string
  audience: string
  subject: string
  projectRef: string
  scopes: string[]
  organizationId?: string
  bindingId?: string
  requestId?: string
  aal?: string
  aalAuthenticatedAt?: number
}): string {
  if (
    Buffer.byteLength(input.key) < 32 ||
    !input.issuer ||
    !input.audience ||
    !input.subject ||
    !input.projectRef ||
    input.scopes.length === 0
  ) {
    throw new Error('Management service assertion configuration is incomplete')
  }
  const now = Math.floor(Date.now() / 1000)
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({
      iss: input.issuer,
      sub: input.subject,
      aud: input.audience,
      nbf: now - 5,
      iat: now,
      exp: now + 60,
      jti: randomUUID(),
      scopes: input.scopes,
      roles: ['studio'],
      projects: [input.projectRef],
      ...(input.organizationId ? { organization_id: input.organizationId } : {}),
      ...(input.bindingId ? { binding_id: input.bindingId } : {}),
      ...(input.requestId ? { request_id: input.requestId } : {}),
      ...(input.aal ? { aal: input.aal } : {}),
      ...(input.aalAuthenticatedAt ? { aal_authenticated_at: input.aalAuthenticatedAt } : {}),
    })
  ).toString('base64url')
  const signature = createHmac('sha256', input.key)
    .update(`${header}.${payload}`)
    .digest('base64url')
  return `${header}.${payload}.${signature}`
}

function httpsRequestJSON(
  url: URL,
  input: {
    method: 'GET' | 'POST' | 'PUT'
    body?: unknown
    contentType?: string
    ca: string
    headers: Record<string, string>
    responseType?: 'json' | 'text' | 'buffer'
    maxResponseBytes?: number
  }
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const body =
      input.body === undefined
        ? undefined
        : Buffer.isBuffer(input.body)
          ? input.body
          : Buffer.from(JSON.stringify(input.body))
    const request = https.request(
      url,
      {
        method: input.method,
        ca: input.ca,
        rejectUnauthorized: true,
        servername: url.hostname,
        timeout: MANAGEMENT_REQUEST_TIMEOUT_MS,
        headers: {
          Accept: 'application/json',
          ...input.headers,
          ...(body === undefined
            ? {}
            : {
                'Content-Type': input.contentType ?? 'application/json',
                'Content-Length': body.length,
              }),
        },
      },
      (response) => {
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          const responseLimit = Math.min(
            input.maxResponseBytes ?? MANAGEMENT_RESPONSE_LIMIT_BYTES,
            20 << 20
          )
          if (size > responseLimit) {
            request.destroy(new Error('Management target response exceeded the size limit'))
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          if (
            input.responseType === 'buffer' &&
            (response.statusCode ?? 500) >= 200 &&
            (response.statusCode ?? 500) < 300
          ) {
            resolve({
              body: Buffer.concat(chunks),
              contentType: response.headers['content-type'] ?? 'application/octet-stream',
            })
            return
          }
          if (
            input.responseType === 'text' &&
            (response.statusCode ?? 500) >= 200 &&
            (response.statusCode ?? 500) < 300
          ) {
            resolve({ body: text, contentType: response.headers['content-type'] ?? 'text/plain' })
            return
          }
          let parsed: unknown = {}
          if (text !== '') {
            try {
              parsed = JSON.parse(text)
            } catch {
              reject(
                new ManagementTrustDownstreamError(
                  'invalid_response',
                  'Management target returned invalid JSON.',
                  response.statusCode ?? 502
                )
              )
              return
            }
          }
          if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
            const error = z
              .object({
                code: z.string().default('downstream_error'),
                message: z.string().default('Management target request failed'),
                details: z.unknown().default({}),
              })
              .parse(parsed)
            reject(
              new ManagementTrustDownstreamError(
                error.code,
                error.message,
                response.statusCode ?? 502,
                error.details
              )
            )
            return
          }
          resolve(parsed)
        })
      }
    )
    request.on('timeout', () => request.destroy(new Error('Management target request timed out')))
    request.on('error', (error) =>
      reject(
        error instanceof ManagementTrustDownstreamError
          ? error
          : new ManagementTrustDownstreamError(
              'downstream_unavailable',
              'Management target is unavailable.',
              503
            )
      )
    )
    if (body !== undefined) request.write(body)
    request.end()
  })
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`
}
