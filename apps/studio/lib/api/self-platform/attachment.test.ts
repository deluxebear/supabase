import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildCandidateConnectionString,
  CapabilityUnavailable,
  derivePreflightCapabilities,
  DetachOperationConflict,
  detachProject,
  listProjectCapabilities,
  requireProjectCapability,
  runAttachmentPreflight,
  type AttachmentConnectionInput,
} from './attachment'
import { executePlatformQuery } from './db'

vi.mock('./db', () => ({ executePlatformQuery: vi.fn() }))
vi.mock('@/lib/api/self-hosted/util', () => ({ encryptString: vi.fn(() => 'encrypted-dsn') }))
vi.mock('@/lib/api/apiHelpers', () => ({
  constructHeaders: vi.fn((headers: Record<string, string>) => headers),
}))

const LEGACY_CONNECTION: AttachmentConnectionInput = {
  dbHost: 'db.internal',
  dbPort: 5432,
  dbName: 'postgres',
  dbUser: 'supabase_admin',
  dbUserReadonly: 'supabase_read_only_user',
  dbPass: 'password',
  dbPassReadonly: null,
  kongUrl: 'https://stack.example.com',
  restUrl: 'https://stack.example.com/rest/v1/',
  anonKey: 'anon',
  serviceKey: 'service',
  jwtSecret: 'jwt-secret',
  publishableKey: null,
  secretKey: null,
  keyMode: 'legacy-jwt',
  tlsMode: 'verify-full',
  tlsCaReference: '/etc/ssl/fleet/stack-ca.pem',
  logflareUrl: null,
  logflareToken: null,
}

const IDENTITY = {
  system_identifier: '7420000000000000000',
  timeline_id: '1',
  database_oid: '5',
  database_name: 'postgres',
  postgres_major: 17,
  can_create_database_objects: true,
  can_read_metadata: true,
}

function response(status: number, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

beforeEach(() => {
  vi.mocked(executePlatformQuery).mockReset().mockResolvedValue({ data: [], error: undefined })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      if (url.endsWith('/query')) return response(200, [IDENTITY])
      if (url.includes('/.well-known/jwks.json')) {
        return response(200, { keys: [{ kid: 'key-2026-07' }] })
      }
      return response(200)
    })
  )
})

describe('buildCandidateConnectionString', () => {
  it('encodes credentials and carries the explicit TLS contract', () => {
    const value = buildCandidateConnectionString({
      ...LEGACY_CONNECTION,
      dbUser: 'user:name',
      dbPass: 'p@ss/word',
      dbName: 'project db',
    })
    const url = new URL(value)
    expect(decodeURIComponent(url.username)).toBe('user:name')
    expect(decodeURIComponent(url.password)).toBe('p@ss/word')
    expect(decodeURIComponent(url.pathname)).toBe('/project db')
    expect(url.searchParams.get('sslmode')).toBe('verify-full')
    expect(url.searchParams.get('sslrootcert')).toBe('/etc/ssl/fleet/stack-ca.pem')
  })
})

describe('runAttachmentPreflight', () => {
  it('proves identity, records database history evidence, and derives a stable fingerprint', async () => {
    const first = await runAttachmentPreflight(LEGACY_CONNECTION)
    const second = await runAttachmentPreflight(LEGACY_CONNECTION)

    expect(first.outcome).toBe('pass')
    expect(first.stackFingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(second.stackFingerprint).toBe(first.stackFingerprint)
    expect(first.checks.find((check) => check.name === 'postgres-identity')?.evidence).toEqual(
      expect.objectContaining({
        systemIdentifier: IDENTITY.system_identifier,
        timelineId: IDENTITY.timeline_id,
        databaseOid: IDENTITY.database_oid,
      })
    )
    expect(first.checks.find((check) => check.name === 'stack-uniqueness')?.status).toBe('pass')
  })

  it('supports a real asymmetric mode without requiring a JWT secret', async () => {
    const report = await runAttachmentPreflight({
      ...LEGACY_CONNECTION,
      keyMode: 'asymmetric-jwks',
      anonKey: '',
      serviceKey: '',
      jwtSecret: '',
      publishableKey: 'sb_publishable_example',
      secretKey: 'sb_secret_example',
    })

    expect(report.outcome).toBe('pass')
    expect(report.checks.find((check) => check.name === 'key-mode')?.status).toBe('pass')
    expect(report.checks.find((check) => check.name === 'jwks')?.required).toBe(true)
    expect(report.checks.find((check) => check.name === 'jwks')?.evidence).toMatchObject({
      keyIds: ['key-2026-07'],
    })
  })

  it('fails with stack_already_attached evidence before a second project can bind', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({
      data: [{ project_ref: 'project-a' }],
      error: undefined,
    })
    const report = await runAttachmentPreflight(LEGACY_CONNECTION)

    expect(report.outcome).toBe('fail')
    expect(report.checks.find((check) => check.name === 'stack-uniqueness')).toMatchObject({
      status: 'fail',
      evidence: { existingProjectRef: 'project-a' },
    })
  })

  it('keeps optional Realtime failure degraded but fails a required Storage probe', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input)
        if (url.endsWith('/query')) return response(200, [IDENTITY])
        if (url.includes('/storage/v1/status')) return response(503)
        if (url.includes('/realtime/v1/websocket')) return response(503)
        return response(200)
      })
    )
    const report = await runAttachmentPreflight(LEGACY_CONNECTION)

    expect(report.outcome).toBe('fail')
    expect(report.checks.find((check) => check.name === 'storage')).toMatchObject({
      status: 'fail',
      required: true,
    })
    expect(report.checks.find((check) => check.name === 'realtime')).toMatchObject({
      status: 'warning',
      required: false,
    })
  })
})

describe('capability and detach boundaries', () => {
  it('normalizes null blockers at the API boundary', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({
      data: [
        {
          name: 'project.detach',
          state: 'available',
          mode: 'direct',
          source: 'preflight',
          contract_version: 'v1',
          target_version: null,
          observation_revision: 'r1',
          observed_at: '2026-07-15T00:00:00.000Z',
          valid_until: null,
          blockers: null,
        },
      ],
      error: undefined,
    })
    expect(await listProjectCapabilities('project-a')).toEqual([
      expect.objectContaining({ name: 'project.detach', blockers: [] }),
    ])
  })

  it('maps active-operation detach rejection to a stable conflict', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({
      data: undefined,
      error: new Error('operation_conflict: active operations must finish before detach'),
    })
    await expect(
      detachProject({ projectRef: 'project-a', actor: 'owner', correlationId: 'corr' })
    ).rejects.toBeInstanceOf(DetachOperationConflict)
  })

  it('fails closed when Agent capability evidence has expired', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({
      data: [
        {
          name: 'functions.deploy',
          state: 'available',
          mode: 'agent',
          source: 'agent',
          contract_version: 'v1',
          target_version: 'v1.74.0',
          observation_revision: 'agent:1',
          observed_at: '2026-07-15T00:00:00Z',
          valid_until: '1970-01-01T00:00:30Z',
          blockers: [],
        },
      ],
      error: undefined,
    })
    await expect(requireProjectCapability('project-a', 'functions.deploy')).rejects.toMatchObject({
      constructor: CapabilityUnavailable,
      blockers: [{ code: 'capability_stale' }],
    })
  })

  it('derives explicit unavailable capabilities instead of false success', () => {
    const report = {
      contractVersion: 'v1' as const,
      startedAt: '2026-07-15T00:00:00.000Z',
      completedAt: '2026-07-15T00:00:01.000Z',
      outcome: 'fail' as const,
      stackFingerprint: null,
      checks: [
        { name: 'metadata-permissions', status: 'fail' as const, required: true, message: 'no' },
        { name: 'auth', status: 'pass' as const, required: true, message: 'ok' },
        { name: 'storage', status: 'pass' as const, required: true, message: 'ok' },
        { name: 'realtime', status: 'warning' as const, required: false, message: 'offline' },
      ],
    }
    const capabilities = derivePreflightCapabilities(report)
    expect(capabilities.find((item) => item.name === 'database.metadata.read')).toMatchObject({
      state: 'unavailable',
      blockers: [{ code: 'preflight_failed', message: 'no' }],
    })
    expect(capabilities.find((item) => item.name === 'project.detach')?.state).toBe('unavailable')
    expect(capabilities.find((item) => item.name === 'management.target.bind')?.state).toBe(
      'unavailable'
    )
    expect(capabilities.find((item) => item.name === 'management.enrollment.issue')).toMatchObject({
      state: 'unavailable',
      blockers: [{ code: 'management_target_unbound' }],
    })
    expect(capabilities.find((item) => item.name === 'functions.read')?.state).toBe('unavailable')
    expect(capabilities.find((item) => item.name === 'functions.deploy')).toMatchObject({
      state: 'unavailable',
      mode: 'agent',
      blockers: [{ code: 'agent_capability_unavailable' }],
    })
  })
})
