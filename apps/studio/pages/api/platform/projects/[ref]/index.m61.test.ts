import type { JwtPayload } from '@supabase/supabase-js'
import { createMocks } from 'node-mocks-http'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handler } from './index'
import { clearHealthCache } from '@/lib/api/self-platform/health'
import { listSharedDbChildRefs, MISSING_STACK_COLUMN } from '@/lib/api/self-platform/projects'
import {
  ProbeFailed,
  ProjectRowMissing,
  SharedDbLocked,
  updateProjectConnection,
} from '@/lib/api/self-platform/projects-admin'
import { checkPermission, guardProjectRoute } from '@/lib/api/self-platform/rbac/enforce'
import { resolveProjectConnection } from '@/lib/api/self-platform/resolve-connection'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
})

vi.mock('@/lib/api/self-platform/rbac/enforce', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  guardProjectRoute: vi.fn(),
  checkPermission: vi.fn(),
}))
// parse + error classes stay REAL; only the write entry point is mocked.
vi.mock('@/lib/api/self-platform/projects-admin', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  updateProjectConnection: vi.fn(),
}))
vi.mock('@/lib/api/self-platform/projects', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  listSharedDbChildRefs: vi.fn(),
}))
vi.mock('@/lib/api/self-platform/health', () => ({ clearHealthCache: vi.fn() }))
vi.mock('@/lib/api/self-platform/resolve-connection', () => {
  class ProjectNotFound extends Error {}
  return { ProjectNotFound, resolveProjectConnection: vi.fn() }
})

const claimsOf = (sub: string) => ({ sub }) as JwtPayload
const patchReq = (ref: string | string[], body: object) =>
  createMocks({ method: 'PATCH', query: { ref }, body })

// Full-column registry row (M5.0 stack + M2.1 analytics columns present).
const ROW = {
  id: 2,
  ref: 'proj-b',
  organization_id: 1,
  name: 'B',
  status: 'ACTIVE_HEALTHY',
  cloud_provider: 'AWS',
  region: 'local',
  db_host: 'db-b',
  db_port: 5432,
  db_name: 'postgres',
  db_user: 'supabase_admin',
  db_user_readonly: 'supabase_read_only_user',
  kong_url: 'http://kong-b:8000',
  rest_url: 'http://kong-b:8000/rest/v1/',
  db_pass_enc: 'PASS_ENC',
  service_key_enc: 'SVC_ENC',
  anon_key_enc: 'ANON_ENC',
  jwt_secret_enc: 'JWT_ENC',
  publishable_key_enc: null,
  secret_key_enc: 'SECRETKEY_ENC',
  logflare_url: null,
  logflare_token_enc: null,
  metrics_url: 'http://h:9598/metrics',
  metrics_token_enc: 'METRICS_ENC',
  container_name: 'supabase-db',
  k8s_namespace: 'supabase',
  k8s_pod_selector: 'supabase-db-0',
  stack_kind: 'external',
  stack_meta: {},
}
const resolved = { pgConnEncrypted: 'ENC', restUrl: ROW.rest_url, row: ROW }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(guardProjectRoute).mockResolvedValue(true)
  vi.mocked(checkPermission).mockResolvedValue(true)
  vi.mocked(resolveProjectConnection).mockResolvedValue(resolved as never)
  vi.mocked(updateProjectConnection).mockResolvedValue({ propagatedChildren: [] })
  vi.mocked(listSharedDbChildRefs).mockResolvedValue([])
})

describe('PATCH /platform/projects/[ref] (self-platform)', () => {
  it('happy rename → guard(write:Update, projects), 200 detail + empty propagated_children, no cache clear', async () => {
    const { req, res } = patchReq('proj-b', { name: 'Renamed' })
    await handler(req as never, res as never, claimsOf('g-admin'))
    expect(vi.mocked(guardProjectRoute).mock.calls[0][2]).toMatchObject({
      action: 'write:Update',
      projectRef: 'proj-b',
      resource: 'projects',
    })
    expect(updateProjectConnection).toHaveBeenCalledWith('proj-b', { name: 'Renamed' })
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toMatchObject({
      ref: 'proj-b',
      connectionString: 'ENC',
      propagated_children: [],
    })
    expect(clearHealthCache).not.toHaveBeenCalled()
  })

  it('upstream rename payload shape passes: unknown cloud keys ignored', async () => {
    const { req, res } = patchReq('proj-b', { name: 'Renamed', cloud_provider: 'AWS' })
    await handler(req as never, res as never, claimsOf('g-admin'))
    expect(updateProjectConnection).toHaveBeenCalledWith('proj-b', { name: 'Renamed' })
    expect(res._getStatusCode()).toBe(200)
  })

  it('connection patch → per-ref cache invalidation for the row AND each propagated child', async () => {
    vi.mocked(updateProjectConnection).mockResolvedValue({ propagatedChildren: ['child-a'] })
    const { req, res } = patchReq('proj-b', { connection: { kongUrl: 'http://k2:8000' } })
    await handler(req as never, res as never, claimsOf('g-admin'))
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData()).toMatchObject({ propagated_children: ['child-a'] })
    expect(vi.mocked(clearHealthCache).mock.calls).toEqual([['proj-b'], ['child-a']])
  })

  it('immutable field → 400 naming it, data layer untouched', async () => {
    const { req, res } = patchReq('proj-b', { ref: 'evil' })
    await handler(req as never, res as never, claimsOf('g-admin'))
    expect(res._getStatusCode()).toBe(400)
    expect(res._getJSONData()).toEqual({ message: 'Field "ref" cannot be changed' })
    expect(updateProjectConnection).not.toHaveBeenCalled()
  })

  it('empty patch → 400', async () => {
    const { req, res } = patchReq('proj-b', { status: 'HACKED' })
    await handler(req as never, res as never, claimsOf('g-admin'))
    expect(res._getStatusCode()).toBe(400)
    expect(res._getJSONData()).toEqual({ message: 'No editable fields in request body' })
  })

  it('SharedDbLocked → 400 with the lock message', async () => {
    vi.mocked(updateProjectConnection).mockRejectedValue(
      new SharedDbLocked(
        'Connection fields of a shared-db project are managed by its host stack "default"'
      )
    )
    const { req, res } = patchReq('child-a', { connection: { dbHost: 'x' } })
    await handler(req as never, res as never, claimsOf('g-admin'))
    expect(res._getStatusCode()).toBe(400)
    expect(res._getJSONData().message).toContain('managed by its host stack')
    expect(clearHealthCache).not.toHaveBeenCalled()
  })

  it('ProbeFailed → 400 with the Could-not-connect prefix', async () => {
    vi.mocked(updateProjectConnection).mockRejectedValue(new ProbeFailed('timeout'))
    const { req, res } = patchReq('proj-b', { connection: { dbHost: '10.255.255.1' } })
    await handler(req as never, res as never, claimsOf('g-admin'))
    expect(res._getStatusCode()).toBe(400)
    expect(res._getJSONData()).toEqual({ message: 'Could not connect to database: timeout' })
  })

  it('ProjectRowMissing → 404 Project not found', async () => {
    vi.mocked(updateProjectConnection).mockRejectedValue(new ProjectRowMissing('default'))
    const { req, res } = patchReq('default', { name: 'x' })
    await handler(req as never, res as never, claimsOf('g-admin'))
    expect(res._getStatusCode()).toBe(404)
    expect(res._getJSONData()).toEqual({ message: 'Project not found' })
  })

  it('guard denial short-circuits before parse and data layer', async () => {
    vi.mocked(guardProjectRoute).mockResolvedValue(false)
    const { req, res } = patchReq('proj-b', { name: 'x' })
    await handler(req as never, res as never, claimsOf('g-dev'))
    expect(updateProjectConnection).not.toHaveBeenCalled()
  })

  it('array ref → 400 before the guard', async () => {
    const { req, res } = patchReq(['a', 'b'], { name: 'x' })
    await handler(req as never, res as never, claimsOf('g-admin'))
    expect(res._getStatusCode()).toBe(400)
    expect(guardProjectRoute).not.toHaveBeenCalled()
  })

  it('unsupported method → 405 with Allow GET,PATCH,DELETE', async () => {
    const { req, res } = createMocks({ method: 'PUT', query: { ref: 'x' } })
    await handler(req as never, res as never, claimsOf('g-1'))
    expect(res._getStatusCode()).toBe(405)
    expect(res._getHeaders().allow).toEqual(['GET', 'PATCH', 'DELETE'])
  })
})

describe('GET self_platform block (M6.1)', () => {
  it('external row → prefill block with secrets as booleans only; children listed; no ciphertext leaves', async () => {
    vi.mocked(listSharedDbChildRefs).mockResolvedValue(['child-a', 'child-b'])
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as never, res as never, claimsOf('g-1'))
    expect(res._getStatusCode()).toBe(200)
    expect(listSharedDbChildRefs).toHaveBeenCalledWith('proj-b')
    expect(res._getJSONData().self_platform).toEqual({
      stack_kind: 'external',
      host_ref: null,
      db_host: 'db-b',
      db_port: 5432,
      db_name: 'postgres',
      db_user: 'supabase_admin',
      db_user_readonly: 'supabase_read_only_user',
      kong_url: 'http://kong-b:8000',
      rest_url: 'http://kong-b:8000/rest/v1/',
      logflare_url: null,
      metrics_url: 'http://h:9598/metrics',
      container_name: 'supabase-db',
      k8s_namespace: 'supabase',
      k8s_pod_selector: 'supabase-db-0',
      secrets_set: {
        db_pass: true,
        anon_key: true,
        service_key: true,
        jwt_secret: true,
        publishable_key: false,
        secret_key: true,
        logflare_token: false,
        metrics_token: true,
      },
      shared_children: ['child-a', 'child-b'],
    })
    const raw = JSON.stringify(res._getJSONData())
    for (const ciphertext of [
      'PASS_ENC',
      'SVC_ENC',
      'ANON_ENC',
      'JWT_ENC',
      'SECRETKEY_ENC',
      'METRICS_ENC',
    ]) {
      expect(raw).not.toContain(ciphertext)
    }
  })

  it('shared-db row → host_ref surfaced, children query skipped', async () => {
    const sharedRow = {
      ...ROW,
      ref: 'child-a',
      stack_kind: 'shared-db',
      stack_meta: { host_ref: 'proj-b' },
      metrics_url: null,
      metrics_token_enc: null,
      container_name: null,
    }
    vi.mocked(resolveProjectConnection).mockResolvedValue({
      ...resolved,
      row: sharedRow,
    } as never)
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'child-a' } })
    await handler(req as never, res as never, claimsOf('g-1'))
    expect(listSharedDbChildRefs).not.toHaveBeenCalled()
    expect(res._getJSONData().self_platform).toMatchObject({
      stack_kind: 'shared-db',
      host_ref: 'proj-b',
      shared_children: [],
      metrics_url: null,
      container_name: null,
      secrets_set: { metrics_token: false },
    })
  })

  it('pre-M5.0 platform-db (missing stack columns) degrades to empty children, still 200', async () => {
    vi.mocked(listSharedDbChildRefs).mockRejectedValue(new Error(MISSING_STACK_COLUMN))
    const { req, res } = createMocks({ method: 'GET', query: { ref: 'proj-b' } })
    await handler(req as never, res as never, claimsOf('g-1'))
    expect(res._getStatusCode()).toBe(200)
    expect(res._getJSONData().self_platform.shared_children).toEqual([])
  })
})
