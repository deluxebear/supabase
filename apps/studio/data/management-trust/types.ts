import { z } from 'zod'

export const managementDomainResponseSchema = z.object({
  domain: z.enum(['fleet-control', 'backup-operator']),
  apiUrl: z.string().url(),
  audience: z.string(),
  contractVersion: z.string(),
  capabilitySchemaPrefix: z.string(),
  targetVersion: z.string().nullable(),
  state: z.enum(['unverified', 'available', 'unavailable', 'incompatible', 'revoked']),
  observedAt: z.string().datetime({ offset: true }).nullable(),
})

export const managementTargetResponseSchema = z.object({
  id: z.string().uuid(),
  organizationId: z.number().int().positive(),
  name: z.string(),
  trustDomain: z.string(),
  caReference: z.string(),
  assertionKeyReference: z.string(),
  state: z.enum(['active', 'disabled', 'revoked']),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
  domains: z.array(managementDomainResponseSchema),
})

export type ManagementTargetResponse = z.infer<typeof managementTargetResponseSchema>

export type ManagementTargetCreatePayload = {
  name: string
  trustDomain: string
  caReference: string
  assertionKeyReference: string
  domains: Array<{
    domain: 'fleet-control' | 'backup-operator'
    apiUrl: string
    audience: string
    contractVersion: string
    capabilitySchemaPrefix: string
  }>
}

export const managementBindingResponseSchema = z.object({
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
  domains: z.array(managementDomainResponseSchema),
})

export type ManagementBindingResponse = z.infer<typeof managementBindingResponseSchema>

export type ManagementBindingPayload = {
  managementTargetId: string
  executionTarget: string
  deploymentKind: 'compose' | 'kubernetes' | 'systemd' | 'bare-metal'
  allowedCapabilityPrefixes: string[]
}

export const enrollmentTokenResponseSchema = z.object({
  id: z.string(),
  bindingId: z.string().uuid(),
  token: z.string().min(32),
  expiresAt: z.string().datetime({ offset: true }),
})

export type EnrollmentTokenResponse = z.infer<typeof enrollmentTokenResponseSchema>
