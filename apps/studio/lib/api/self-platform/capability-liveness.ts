import type { ProjectCapabilityRecord } from './attachment'

const DEFAULT_STALE_GRACE_MS = 30_000

export function projectCapabilityAt(
  capability: ProjectCapabilityRecord,
  nowMs = Date.now()
): ProjectCapabilityRecord {
  if (capability.source !== 'agent' || capability.validUntil === null) return capability
  const validUntilMs = Date.parse(capability.validUntil)
  if (!Number.isFinite(validUntilMs) || nowMs <= validUntilMs) return capability

  if (nowMs <= validUntilMs + DEFAULT_STALE_GRACE_MS) {
    return {
      ...capability,
      state: 'stale',
      blockers: [
        {
          code: 'capability_stale',
          message: `Capability ${capability.name} has stale Agent evidence.`,
          remediation: 'Restore the Agent heartbeat before retrying this operation.',
        },
      ],
    }
  }

  return {
    ...capability,
    state: 'unavailable',
    blockers: [
      {
        code: 'agent_unavailable',
        message: `Capability ${capability.name} is unavailable because the Agent lease expired.`,
        remediation: 'Restore the Agent connection and wait for a fresh capability observation.',
      },
    ],
  }
}
