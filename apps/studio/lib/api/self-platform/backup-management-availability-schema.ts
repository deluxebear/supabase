import { z } from 'zod'

export const backupManagementAvailabilitySchema = z.object({
  state: z.enum([
    'unconfigured',
    'checking',
    'available',
    'offline',
    'incompatible',
    'unauthorized',
  ]),
  configured: z.boolean(),
  blockers: z.array(
    z.object({
      code: z.string().min(1),
      message: z.string().min(1),
      remediation: z.string().optional(),
    })
  ),
  correlationId: z.string().uuid(),
})

export type BackupManagementAvailability = z.infer<typeof backupManagementAvailabilitySchema>
