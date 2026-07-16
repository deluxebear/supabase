import { z } from 'zod'

import { getProjectManagementBinding, requestManagementDomain } from './management-trust'

const operationStateSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
])

const operationAttemptSchema = z.object({
  attempt: z.number().int().positive(),
  taskId: z.string(),
  agentId: z.string(),
  state: z.enum(['running', 'succeeded', 'failed', 'timed_out']),
  evidenceSchema: z.string().optional(),
  evidence: z.unknown().optional(),
  errorCode: z.string().optional(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().optional(),
})

export const fleetOperationSchema = z.object({
  id: z.string(),
  projectRef: z.string(),
  targetId: z.string(),
  bindingId: z.string(),
  domain: z.string(),
  capability: z.string(),
  state: operationStateSchema,
  protocolMajor: z.number().int(),
  protocolMinor: z.number().int(),
  expectedGeneration: z.number().int(),
  desiredRevision: z.string().uuid(),
  desiredDigest: z.string().regex(/^[0-9a-f]{64}$/),
  inputSchema: z.string(),
  fencingToken: z.number().int().positive(),
  taskId: z.string().optional(),
  agentId: z.string().optional(),
  evidenceSchema: z.string().optional(),
  evidence: z.unknown().optional(),
  errorCode: z.string().optional(),
  attempts: z.number().int().nonnegative(),
  correlationId: z.string(),
  deadlineAt: z.string().datetime(),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  attemptHistory: z.array(operationAttemptSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})

async function requestFleetOperation(input: {
  projectRef: string
  operationId: string
  actor: string
  correlationId: string
  action?: 'cancel' | 'retry'
}) {
  const binding = await getProjectManagementBinding(input.projectRef)
  if (!binding || binding.targetState !== 'active') {
    throw new Error('An active management target is required to access Fleet operations')
  }
  const suffix = input.action === undefined ? '' : `/${input.action}`
  const response = await requestManagementDomain(binding, 'fleet-control', {
    method: input.action === undefined ? 'GET' : 'POST',
    path: `/platform/fleet/v1/projects/${encodeURIComponent(input.projectRef)}/operations/${encodeURIComponent(input.operationId)}${suffix}`,
    scopes: [input.action === undefined ? 'fleet.read' : 'fleet.execute'],
    actor: input.actor,
    correlationId: input.correlationId,
  })
  const operation = fleetOperationSchema.parse(response)
  if (operation.projectRef !== input.projectRef || operation.id !== input.operationId) {
    throw new Error('Fleet Control returned a mismatched operation identity')
  }
  return operation
}

export function getFleetOperation(input: {
  projectRef: string
  operationId: string
  actor: string
  correlationId: string
}) {
  return requestFleetOperation(input)
}

export function cancelFleetOperation(input: {
  projectRef: string
  operationId: string
  actor: string
  correlationId: string
}) {
  return requestFleetOperation({ ...input, action: 'cancel' })
}

export function retryFleetOperation(input: {
  projectRef: string
  operationId: string
  actor: string
  correlationId: string
}) {
  return requestFleetOperation({ ...input, action: 'retry' })
}
