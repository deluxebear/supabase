import { z } from 'zod'

import { backupManagementAvailabilitySchema } from './backup-management-availability-schema'

export const backupOperatorStatusSchema = z.object({
  configured: z.boolean(),
  policy: z.object({
    enabled: z.boolean(),
    retentionDays: z.number().int().positive().nullable(),
    schedule: z.string().nullable(),
    backupFrom: z.enum(['primary', 'standby']).nullable(),
  }),
  provider: z.object({ name: z.string(), version: z.string().nullable() }),
  topology: z.object({
    kind: z.string(),
    primary: z.string().nullable(),
    standbys: z.number().int(),
  }),
  repository: z.object({ type: z.string().nullable(), location: z.string().nullable() }),
  check: z.object({
    status: z.enum(['healthy', 'degraded', 'unknown']),
    checkedAt: z.string().nullable(),
    message: z.string().nullable(),
  }),
  lastJob: z
    .object({ type: z.string(), state: z.string(), finishedAt: z.string().nullable() })
    .nullable(),
  capabilities: z.object({
    backup: z.boolean(),
    restore: z.boolean(),
    blockers: z.array(z.string()),
  }),
  compatibility: z.object({
    image: z.string().nullable(),
    supported: z.boolean(),
    blocker: z.string().nullable(),
  }),
  updatedAt: z.string().nullable(),
  management: backupManagementAvailabilitySchema.optional(),
})

export type BackupOperatorStatus = z.infer<typeof backupOperatorStatusSchema>

export const unavailableBackupOperatorStatus: BackupOperatorStatus = {
  configured: false,
  policy: { enabled: false, retentionDays: null, schedule: null, backupFrom: null },
  provider: { name: 'pgBackRest', version: null },
  topology: { kind: 'unknown', primary: null, standbys: 0 },
  repository: { type: null, location: null },
  check: {
    status: 'unknown',
    checkedAt: null,
    message: 'No Backup Operator status has been published',
  },
  lastJob: null,
  capabilities: {
    backup: false,
    restore: false,
    blockers: ['Install and enroll the Backup Operator before enabling PITR'],
  },
  compatibility: {
    image: null,
    supported: false,
    blocker: 'Database image compatibility has not been verified',
  },
  updatedAt: null,
}
