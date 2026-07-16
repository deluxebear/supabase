import { z } from 'zod'

export const ownershipModeSchema = z.enum(['observe-only', 'direct-managed', 'gitops-managed'])

const blockerSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  remediation: z.string().optional(),
  resource: z.string().optional(),
  field: z.string().optional(),
  owner: z.string().optional(),
})

export const ownershipPolicySchema = z.object({
  projectRef: z.string().min(1),
  domain: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  ownershipMode: ownershipModeSchema,
  adapter: z.enum(['compose', 'kubernetes', 'systemd', 'bare-metal']),
  policyRevision: z.number().int().positive(),
  driftState: z.enum(['unknown', 'in-sync', 'drifted', 'ownership-conflict']),
  blockers: z.array(blockerSchema),
  lastOperationId: z.string().nullable(),
  lastObservedGeneration: z.number().int().positive().nullable(),
  lastObservedDigest: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  lastObservedAt: z.string().datetime({ offset: true }).nullable(),
  updatedAt: z.string().datetime({ offset: true }),
})

export type OwnershipPolicy = z.infer<typeof ownershipPolicySchema>

export const ownershipPolicyInputSchema = z.object({
  domain: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  ownershipMode: ownershipModeSchema,
  expectedRevision: z.number().int().nonnegative(),
})
