import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './index'
import {
  AttachmentPreflightFailed,
  StackAlreadyAttached,
  type AttachmentPreflightReport,
} from '@/lib/api/self-platform/attachment'
import {
  attachExternalProject,
  DuplicateRef,
  ProbeFailed,
  stageExternalProject,
} from '@/lib/api/self-platform/projects-admin'
import { guardOrgRoute } from '@/lib/api/self-platform/rbac/enforce'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_STUDIO_DEPLOYMENT_PROFILE = 'fleet'
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
})

vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardOrgRoute: vi.fn() }))
vi.mock('@/lib/api/self-platform/projects-admin', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  attachExternalProject: vi.fn(),
  stageExternalProject: vi.fn(),
}))
// GET-path deps — the POST tests never reach them, but the module imports them.
vi.mock('@/lib/api/self-platform/list-user-projects', () => ({ listAllProjectsV2: vi.fn() }))
vi.mock('@/lib/api/self-platform/members', () => ({ getMemberContext: vi.fn() }))

const claimsOf = (sub: string) => ({ sub }) as JwtPayload

const SHARED_BODY = {
  mode: 'shared-db',
  organization_slug: 'default',
  name: 'Team A',
  ref: 'team-a',
}
const EXTERNAL_BODY = {
  mode: 'external',
  organization_slug: 'default',
  name: 'Ext',
  ref: 'ext-1',
  connection: {
    dbHost: 'h',
    dbPass: 'p',
    kongUrl: 'http://k:8000',
    anonKey: 'a',
    serviceKey: 's',
    jwtSecret: 'j',
  },
}
const STAGED_BODY = {
  ...EXTERNAL_BODY,
  attachment_mode: 'staged',
  public_endpoints: {
    apiUrl: 'https://api.project-a.example.com',
    restUrl: 'https://api.project-a.example.com/rest/v1',
    authUrl: 'https://api.project-a.example.com/auth/v1',
    storageUrl: 'https://api.project-a.example.com/storage/v1',
    realtimeUrl: 'https://api.project-a.example.com/realtime/v1',
    functionsUrl: 'https://api.project-a.example.com/functions/v1',
    s3Url: 'https://api.project-a.example.com/storage/v1/s3',
    directPostgres: {
      host: 'db.project-a.example.com',
      port: 5432,
      database: 'postgres',
      user: 'postgres',
      tlsMode: 'require',
    },
    supavisor: {
      host: 'pooler.project-a.example.com',
      transactionPort: 6543,
      sessionPort: 5432,
      database: 'postgres',
      user: 'postgres',
      tenantId: 'project-a',
      tlsMode: 'require',
    },
  },
}
const FAILED_REPORT: AttachmentPreflightReport = {
  contractVersion: 'v1',
  startedAt: '2026-07-15T00:00:00.000Z',
  completedAt: '2026-07-15T00:00:01.000Z',
  outcome: 'fail',
  stackFingerprint: 'a'.repeat(64),
  checks: [
    {
      name: 'storage',
      status: 'fail',
      required: true,
      message: 'Storage returned HTTP 503',
    },
  ],
}

beforeEach(() => {
  vi.mocked(guardOrgRoute).mockReset().mockResolvedValue({ orgId: 1, orgSlug: 'default' })
  vi.mocked(attachExternalProject).mockReset().mockResolvedValue({ id: 8 })
  vi.mocked(stageExternalProject)
    .mockReset()
    .mockResolvedValue({ id: 9, connectionRevision: 1, preflight: FAILED_REPORT })
})

const post = (body: object) => createMocks({ method: 'POST', body })

describe('POST /platform/projects (self-platform)', () => {
  it('rejects shared-db creation because a Fleet project must bind one independent stack', async () => {
    const { req, res } = post(SHARED_BODY)
    await handler(req as never, res as never, claimsOf('g-owner'))
    expect(vi.mocked(guardOrgRoute).mock.calls[0][2]).toMatchObject({
      slug: 'default',
      action: 'write:Create',
      resource: 'projects',
    })
    expect(res._getStatusCode()).toBe(400)
    expect(res._getJSONData()).toEqual({
      code: 'validation_failed',
      message:
        'Shared-database project creation is incompatible with one-project-per-stack attachment. Attach an independent stack instead.',
    })
  })

  it('external happy path → 201 via attachExternalProject', async () => {
    const { req, res } = post(EXTERNAL_BODY)
    await handler(req as never, res as never, claimsOf('g-owner'))
    expect(attachExternalProject).toHaveBeenCalled()
    expect(res._getStatusCode()).toBe(201)
    expect(res._getJSONData()).toMatchObject({ id: 8, ref: 'ext-1' })
  })

  it('stages a verified project without reporting it active', async () => {
    const { req, res } = post(STAGED_BODY)
    await handler(req as never, res as never, claimsOf('g-owner'))
    expect(stageExternalProject).toHaveBeenCalledWith(
      expect.objectContaining({ ref: 'ext-1', publicEndpoints: STAGED_BODY.public_endpoints })
    )
    expect(attachExternalProject).not.toHaveBeenCalled()
    expect(res._getStatusCode()).toBe(201)
    expect(res._getJSONData()).toMatchObject({
      status: 'COMING_UP',
      attachment_state: 'validating',
    })
  })

  it('rejects Docker-only public endpoints before staging', async () => {
    const { req, res } = post({
      ...STAGED_BODY,
      public_endpoints: { ...STAGED_BODY.public_endpoints, apiUrl: 'http://kong:8000' },
    })
    await handler(req as never, res as never, claimsOf('g-owner'))
    expect(res._getStatusCode()).toBe(400)
    expect(res._getJSONData()).toMatchObject({ code: 'validation_failed' })
    expect(stageExternalProject).not.toHaveBeenCalled()
  })

  it.each([
    [{ ...SHARED_BODY, mode: 'k8s' }, /mode/],
    [{ ...SHARED_BODY, organization_slug: undefined }, /organization_slug/],
    [{ ...SHARED_BODY, name: '' }, /name/],
    [{ ...SHARED_BODY, name: 'x'.repeat(65) }, /name/],
    [{ ...SHARED_BODY, ref: 'Bad_Ref' }, /ref/i],
    [{ ...SHARED_BODY, ref: 'default' }, /reserved/],
  ])('validation rejects %j before the guard', async (body, msg) => {
    const { req, res } = post(body as object)
    await handler(req as never, res as never, claimsOf('g-owner'))
    expect(res._getStatusCode()).toBe(400)
    expect(res._getJSONData().message).toMatch(msg)
    expect(guardOrgRoute).not.toHaveBeenCalled()
  })

  it('external with missing connection fields → 400 naming them (after guard)', async () => {
    const { req, res } = post({
      mode: 'external',
      organization_slug: 'default',
      name: 'Ext',
      ref: 'ext-1',
      connection: { dbHost: 'h' },
    })
    await handler(req as never, res as never, claimsOf('g-owner'))
    expect(res._getStatusCode()).toBe(400)
    expect(res._getJSONData().message).toMatch(/dbPass/)
    expect(attachExternalProject).not.toHaveBeenCalled()
  })

  it('guard denial short-circuits before the data layer', async () => {
    vi.mocked(guardOrgRoute).mockResolvedValue(null)
    const { req, res } = post(SHARED_BODY)
    await handler(req as never, res as never, claimsOf('g-dev'))
    expect(attachExternalProject).not.toHaveBeenCalled()
  })

  it('rejects a stale or missing session before starting preflight', async () => {
    vi.mocked(guardOrgRoute).mockImplementation(async (res) => {
      res.status(401).json({ code: 'forbidden', message: 'Session expired' })
      return null
    })
    const { req, res } = post(EXTERNAL_BODY)
    await handler(req as never, res as never, undefined)
    expect(res._getStatusCode()).toBe(401)
    expect(attachExternalProject).not.toHaveBeenCalled()
  })

  it('returns the structured preflight report without creating a false healthy project', async () => {
    vi.mocked(attachExternalProject).mockRejectedValue(new AttachmentPreflightFailed(FAILED_REPORT))
    const { req, res } = post(EXTERNAL_BODY)
    await handler(req as never, res as never, claimsOf('g-owner'))
    expect(res._getStatusCode()).toBe(422)
    expect(res._getJSONData()).toEqual({
      code: 'preflight_failed',
      message: 'Attachment preflight failed',
      preflight: FAILED_REPORT,
    })
  })

  it('returns stack_already_attached with owner remediation context', async () => {
    vi.mocked(attachExternalProject).mockRejectedValue(new StackAlreadyAttached('project-a'))
    const { req, res } = post(EXTERNAL_BODY)
    await handler(req as never, res as never, claimsOf('g-owner'))
    expect(res._getStatusCode()).toBe(409)
    expect(res._getJSONData()).toMatchObject({
      code: 'stack_already_attached',
      existing_project_ref: 'project-a',
    })
  })

  it('DuplicateRef → 409', async () => {
    vi.mocked(attachExternalProject).mockRejectedValue(new DuplicateRef('team-a'))
    const { req, res } = post(EXTERNAL_BODY)
    await handler(req as never, res as never, claimsOf('g-owner'))
    expect(res._getStatusCode()).toBe(409)
    expect(res._getJSONData()).toEqual({ message: 'A project with this ref already exists' })
  })

  it('ProbeFailed → 400 with the cause', async () => {
    vi.mocked(attachExternalProject).mockRejectedValue(new ProbeFailed('connect ECONNREFUSED'))
    const { req, res } = post(EXTERNAL_BODY)
    await handler(req as never, res as never, claimsOf('g-owner'))
    expect(res._getStatusCode()).toBe(400)
    expect(res._getJSONData()).toEqual({
      message: 'Could not connect to database: connect ECONNREFUSED',
    })
  })

  it('unsupported method → 405 with Allow GET,POST', async () => {
    const { req, res } = createMocks({ method: 'PUT' })
    await handler(req as never, res as never, claimsOf('g-1'))
    expect(res._getStatusCode()).toBe(405)
    expect(res._getHeaders().allow).toEqual(['GET', 'POST'])
  })
})
