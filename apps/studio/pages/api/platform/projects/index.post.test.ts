import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './index'
import {
  attachExternalProject,
  createSharedDbProject,
  DuplicateRef,
  ProbeFailed,
} from '@/lib/api/self-platform/projects-admin'
import { guardOrgRoute } from '@/lib/api/self-platform/rbac/enforce'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
})

vi.mock('@/lib/api/self-platform/rbac/enforce', () => ({ guardOrgRoute: vi.fn() }))
vi.mock('@/lib/api/self-platform/projects-admin', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createSharedDbProject: vi.fn(),
  attachExternalProject: vi.fn(),
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

beforeEach(() => {
  vi.mocked(guardOrgRoute).mockReset().mockResolvedValue({ orgId: 1, orgSlug: 'default' })
  vi.mocked(createSharedDbProject).mockReset().mockResolvedValue({ id: 7 })
  vi.mocked(attachExternalProject).mockReset().mockResolvedValue({ id: 8 })
})

const post = (body: object) => createMocks({ method: 'POST', body })

describe('POST /platform/projects (self-platform)', () => {
  it('shared-db happy path → 201 with host_ref defaulting to default', async () => {
    const { req, res } = post(SHARED_BODY)
    await handler(req as never, res as never, claimsOf('g-owner'))
    expect(vi.mocked(guardOrgRoute).mock.calls[0][2]).toMatchObject({
      slug: 'default',
      action: 'write:Create',
      resource: 'projects',
    })
    expect(createSharedDbProject).toHaveBeenCalledWith({
      ref: 'team-a',
      name: 'Team A',
      hostRef: 'default',
      organizationId: 1,
    })
    expect(res._getStatusCode()).toBe(201)
    expect(res._getJSONData()).toEqual({
      id: 7,
      ref: 'team-a',
      name: 'Team A',
      status: 'ACTIVE_HEALTHY',
      organization_slug: 'default',
    })
  })

  it('external happy path → 201 via attachExternalProject', async () => {
    const { req, res } = post({
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
    })
    await handler(req as never, res as never, claimsOf('g-owner'))
    expect(attachExternalProject).toHaveBeenCalled()
    expect(res._getStatusCode()).toBe(201)
    expect(res._getJSONData()).toMatchObject({ id: 8, ref: 'ext-1' })
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
    expect(createSharedDbProject).not.toHaveBeenCalled()
  })

  it('DuplicateRef → 409', async () => {
    vi.mocked(createSharedDbProject).mockRejectedValue(new DuplicateRef('team-a'))
    const { req, res } = post(SHARED_BODY)
    await handler(req as never, res as never, claimsOf('g-owner'))
    expect(res._getStatusCode()).toBe(409)
    expect(res._getJSONData()).toEqual({ message: 'A project with this ref already exists' })
  })

  it('ProbeFailed → 400 with the cause', async () => {
    vi.mocked(attachExternalProject).mockRejectedValue(new ProbeFailed('connect ECONNREFUSED'))
    const { req, res } = post({
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
    })
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
