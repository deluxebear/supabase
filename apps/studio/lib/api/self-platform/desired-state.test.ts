import { beforeEach, describe, expect, it, vi } from 'vitest'

import { executePlatformQuery } from './db'
import {
  CapacityExceededError,
  applyConfigurationObservation,
  commitDesiredConfiguration,
  ConfigurationConflictError,
  getOperationSummary,
} from './desired-state'

vi.mock('./db', () => ({ executePlatformQuery: vi.fn() }))

const baseInput = {
  projectRef: 'project-a',
  domain: 'auth',
  capability: 'auth.config.apply',
  expectedGeneration: 0,
  operationId: 'op-a',
  targetId: 'target-a',
  bindingId: 'binding-a',
  inputSchema: 'supabase.fleet.auth.config.apply.v1',
  idempotencyKey: 'idem-a',
  desiredDocument: { enabled: true },
  preconditions: {},
  actor: 'user-a',
  correlationId: 'request-a',
}

describe('Fleet desired-state authority', () => {
  beforeEach(() => vi.resetAllMocks())

  it('commits desired state and outbox through one database function', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({
      data: [
        {
          operation_id: 'op-a',
          revision_id: '11111111-1111-4111-8111-111111111111',
          generation: '1',
          desired_digest: 'a'.repeat(64),
          replayed: false,
        },
      ],
      error: undefined,
    })
    await expect(commitDesiredConfiguration(baseInput)).resolves.toEqual({
      operationId: 'op-a',
      revisionId: '11111111-1111-4111-8111-111111111111',
      generation: 1,
      desiredDigest: 'a'.repeat(64),
      isReplayed: false,
    })
    expect(vi.mocked(executePlatformQuery).mock.calls[0][0].parameters).toEqual([
      'project-a',
      'auth',
      'auth.config.apply',
      0,
      'op-a',
      'target-a',
      'binding-a',
      'supabase.fleet.auth.config.apply.v1',
      'idem-a',
      '{"enabled":true}',
      '{}',
      'user-a',
      'request-a',
    ])
  })

  it('maps optimistic concurrency failures to a stable code', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({
      data: undefined,
      error: new Error('configuration_conflict'),
    })
    await expect(
      commitDesiredConfiguration({ ...baseInput, expectedGeneration: 4 })
    ).rejects.toBeInstanceOf(ConfigurationConflictError)
  })

  it('maps durable queue quota failures to a stable retryable capacity code', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({
      data: undefined,
      error: new Error('capacity_exceeded: organization queued operation limit reached'),
    })
    await expect(commitDesiredConfiguration(baseInput)).rejects.toBeInstanceOf(
      CapacityExceededError
    )
  })

  it('projects observations only with project, revision, and generation CAS inputs', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({
      data: [{ applied: false }],
      error: undefined,
    })
    await expect(
      applyConfigurationObservation({
        projectRef: 'project-a',
        domain: 'auth',
        desiredRevision: '11111111-1111-4111-8111-111111111111',
        observedGeneration: 1,
        observedDocument: { enabled: false },
        operationId: 'op-a',
        observedAt: '2026-07-15T12:00:00Z',
      })
    ).resolves.toBe(false)
    expect(vi.mocked(executePlatformQuery).mock.calls[0][0].parameters?.slice(0, 4)).toEqual([
      'project-a',
      'auth',
      '11111111-1111-4111-8111-111111111111',
      1,
    ])
  })

  it('filters operation summaries by both project and operation identity', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({ data: [], error: undefined })
    await expect(getOperationSummary('project-b', 'op-a')).resolves.toBeNull()
    expect(vi.mocked(executePlatformQuery).mock.calls[0][0].parameters).toEqual([
      'project-b',
      'op-a',
    ])
  })
})
