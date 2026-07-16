import { describe, expect, it } from 'vitest'

import type { ProjectCapabilityRecord } from './attachment'
import { projectCapabilityAt } from './capability-liveness'

const capability: ProjectCapabilityRecord = {
  name: 'functions.deploy',
  state: 'available',
  mode: 'agent',
  source: 'agent',
  contractVersion: 'v1',
  targetVersion: 'v1.0.0',
  observationRevision: 'agent-a:1',
  observedAt: '2026-07-16T00:00:00.000Z',
  validUntil: '2026-07-16T00:00:30.000Z',
  blockers: [],
}

describe('projectCapabilityAt', () => {
  it('keeps fresh Agent evidence available', () => {
    expect(projectCapabilityAt(capability, Date.parse('2026-07-16T00:00:29.000Z'))).toEqual(
      capability
    )
  })

  it('projects expired evidence as stale during the grace period', () => {
    expect(projectCapabilityAt(capability, Date.parse('2026-07-16T00:00:45.000Z'))).toMatchObject({
      state: 'stale',
      blockers: [{ code: 'capability_stale' }],
    })
  })

  it('projects evidence as unavailable after the grace period', () => {
    expect(projectCapabilityAt(capability, Date.parse('2026-07-16T00:01:01.000Z'))).toMatchObject({
      state: 'unavailable',
      blockers: [{ code: 'agent_unavailable' }],
    })
  })

  it('does not expire direct or timeless capabilities', () => {
    expect(
      projectCapabilityAt({ ...capability, source: 'static-profile' }, Number.MAX_SAFE_INTEGER)
    ).toEqual({ ...capability, source: 'static-profile' })
    expect(
      projectCapabilityAt({ ...capability, validUntil: null }, Number.MAX_SAFE_INTEGER)
    ).toEqual({ ...capability, validUntil: null })
  })
})
