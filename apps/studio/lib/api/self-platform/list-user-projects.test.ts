import { beforeEach, describe, expect, it, vi } from 'vitest'

import { listAllProjectsV2, listOrgProjectsV2, visibleProjectScope } from './list-user-projects'
import type { MemberContext } from './members'
import { getOrganizationBySlug, listOrganizations } from './organizations'
import {
  countProjectsByOrgId,
  countProjectsByOrgIdAndIds,
  countProjectsVisible,
  listProjectsByOrgId,
  listProjectsByOrgIdAndIds,
  listProjectsVisible,
} from './projects'

vi.mock('./organizations', () => ({
  getOrganizationBySlug: vi.fn(),
  listOrganizations: vi.fn(),
}))
vi.mock('./projects', () => ({
  listProjectsByOrgId: vi.fn(),
  countProjectsByOrgId: vi.fn(),
  listProjectsByOrgIdAndIds: vi.fn(),
  countProjectsByOrgIdAndIds: vi.fn(),
  listProjectsVisible: vi.fn(),
  countProjectsVisible: vi.fn(),
}))

const org = { id: 1, slug: 'acme', name: 'Acme' }

const rowA = {
  id: 1,
  ref: 'proj-a',
  organization_id: 1,
  name: 'Project A',
  status: 'ACTIVE_HEALTHY',
  cloud_provider: 'AWS',
  region: 'us-east-1',
  db_host: 'db-a',
  db_port: 5432,
  db_name: 'postgres',
  db_user: 'supabase_admin',
  db_user_readonly: 'supabase_read_only_user',
  kong_url: 'http://kong-a:8000',
  rest_url: 'http://kong-a:8000/rest/v1/',
  db_pass_enc: 'x',
  service_key_enc: 'x',
  anon_key_enc: 'x',
  jwt_secret_enc: 'x',
  publishable_key_enc: null,
  secret_key_enc: null,
  logflare_url: null,
  logflare_token_enc: null,
}

const rowB = {
  ...rowA,
  id: 2,
  ref: 'proj-b',
  name: 'Project B',
  organization_id: 2,
  region: 'us-west-2',
}

// [self-platform] M3.0 ctx fixtures (spec §8): org-scoped role -> whole org;
// derived role -> its explicit project ids; zero roles -> nothing.
const ORG_CTX: MemberContext = {
  gotrueId: 'g-1',
  roles: [
    {
      id: 1,
      baseRoleId: 1,
      baseRoleName: 'Owner',
      name: 'Owner',
      orgId: 1,
      orgSlug: 'default',
      projectRefs: [],
      projectIds: [],
    },
  ],
}
const DERIVED_CTX: MemberContext = {
  gotrueId: 'g-5',
  roles: [
    {
      id: 5,
      baseRoleId: 3,
      baseRoleName: 'Developer',
      name: 'Developer_scoped',
      orgId: 1,
      orgSlug: 'default',
      projectRefs: ['proj-b'],
      projectIds: [10],
    },
  ],
}
const ZERO_CTX: MemberContext = { gotrueId: 'g-0', roles: [] }
const MIXED_CTX: MemberContext = {
  gotrueId: 'g-9',
  roles: [...ORG_CTX.roles, ...DERIVED_CTX.roles],
}

beforeEach(() => vi.clearAllMocks())

describe('visibleProjectScope', () => {
  it('org-scoped role -> the whole org', () => {
    expect(visibleProjectScope(ORG_CTX, 1)).toBe('all')
  })

  it('only derived roles -> their project ids', () => {
    expect(visibleProjectScope(DERIVED_CTX, 1)).toEqual([10])
  })

  it('zero roles -> empty scope', () => {
    expect(visibleProjectScope(ZERO_CTX, 1)).toEqual([])
  })

  it('mixed org + derived roles in the same org -> the whole org', () => {
    expect(visibleProjectScope(MIXED_CTX, 1)).toBe('all')
  })
})

describe('listOrgProjectsV2', () => {
  it('lists two registered projects for an org (org-scoped member sees everything)', async () => {
    vi.mocked(getOrganizationBySlug).mockResolvedValue(org)
    vi.mocked(listProjectsByOrgId).mockResolvedValue([rowA, { ...rowB, organization_id: 1 }])
    vi.mocked(countProjectsByOrgId).mockResolvedValue(2)

    const result = await listOrgProjectsV2(ORG_CTX, 'acme')

    expect(getOrganizationBySlug).toHaveBeenCalledWith('acme')
    expect(listProjectsByOrgId).toHaveBeenCalledWith(1, 100, 0)
    expect(countProjectsByOrgId).toHaveBeenCalledWith(1)
    expect(result?.pagination).toEqual({ count: 2, limit: 100, offset: 0 })
    expect(result?.projects).toHaveLength(2)
    expect(result?.projects[0]).toMatchObject({
      ref: 'proj-a',
      name: 'Project A',
      organization_id: 1,
      organization_slug: 'acme',
      integration_source: null,
      is_branch: false,
      preview_branch_refs: [],
      databases: [
        {
          identifier: 'proj-a',
          cloud_provider: 'AWS',
          region: 'us-east-1',
          status: 'ACTIVE_HEALTHY',
          type: 'PRIMARY',
        },
      ],
    })
    expect(result?.projects[1]).toMatchObject({ ref: 'proj-b', organization_slug: 'acme' })
  })

  it('falls back to the single default project when the org has no registered projects (org-scoped, count 0)', async () => {
    vi.mocked(getOrganizationBySlug).mockResolvedValue(org)
    vi.mocked(listProjectsByOrgId).mockResolvedValue([])
    vi.mocked(countProjectsByOrgId).mockResolvedValue(0)

    const result = await listOrgProjectsV2(ORG_CTX, 'acme')

    expect(result?.pagination).toEqual({ count: 1, limit: 100, offset: 0 })
    expect(result?.projects).toHaveLength(1)
    expect(result?.projects[0]).toMatchObject({
      ref: 'default',
      organization_slug: 'acme',
      is_branch: false,
      preview_branch_refs: [],
      databases: [{ identifier: 'default', type: 'PRIMARY' }],
    })
  })

  it('returns empty projects (but count 1) for an empty registry when offset >= 1', async () => {
    vi.mocked(getOrganizationBySlug).mockResolvedValue(org)
    vi.mocked(listProjectsByOrgId).mockResolvedValue([])
    vi.mocked(countProjectsByOrgId).mockResolvedValue(0)

    const result = await listOrgProjectsV2(ORG_CTX, 'acme', 100, 1)

    expect(result?.pagination).toEqual({ count: 1, limit: 100, offset: 1 })
    expect(result?.projects).toEqual([])
  })

  it('returns null when the org is not found', async () => {
    vi.mocked(getOrganizationBySlug).mockResolvedValue(null)

    expect(await listOrgProjectsV2(ORG_CTX, 'nope')).toBeNull()
    expect(listProjectsByOrgId).not.toHaveBeenCalled()
  })

  it('passes limit/offset through to the data layer and pagination', async () => {
    vi.mocked(getOrganizationBySlug).mockResolvedValue(org)
    vi.mocked(listProjectsByOrgId).mockResolvedValue([rowA])
    vi.mocked(countProjectsByOrgId).mockResolvedValue(1)

    const result = await listOrgProjectsV2(ORG_CTX, 'acme', 50, 10)

    expect(listProjectsByOrgId).toHaveBeenCalledWith(1, 50, 10)
    expect(result?.pagination).toEqual({ count: 1, limit: 50, offset: 10 })
  })

  it('zero-role member: fail-closed short-circuit issues NO SQL and NO default fallback', async () => {
    vi.mocked(getOrganizationBySlug).mockResolvedValue({ id: 1, slug: 'default', name: 'Default' })

    const result = await listOrgProjectsV2(ZERO_CTX, 'default')

    expect(result).toEqual({ pagination: { count: 0, limit: 100, offset: 0 }, projects: [] })
    expect(listProjectsByOrgId).not.toHaveBeenCalled()
    expect(countProjectsByOrgId).not.toHaveBeenCalled()
    expect(listProjectsByOrgIdAndIds).not.toHaveBeenCalled()
    expect(countProjectsByOrgIdAndIds).not.toHaveBeenCalled()
  })

  it('derived-scope member: queries by org+ids, and a 0 count means an empty page (NOT the default fallback)', async () => {
    vi.mocked(getOrganizationBySlug).mockResolvedValue(org)
    vi.mocked(listProjectsByOrgIdAndIds).mockResolvedValue([])
    vi.mocked(countProjectsByOrgIdAndIds).mockResolvedValue(0)

    const result = await listOrgProjectsV2(DERIVED_CTX, 'acme')

    expect(listProjectsByOrgIdAndIds).toHaveBeenCalledWith(1, [10], 100, 0)
    expect(countProjectsByOrgIdAndIds).toHaveBeenCalledWith(1, [10])
    expect(result).toEqual({ pagination: { count: 0, limit: 100, offset: 0 }, projects: [] })
    expect(listProjectsByOrgId).not.toHaveBeenCalled()
    expect(countProjectsByOrgId).not.toHaveBeenCalled()
  })

  it('derived-scope member: non-zero count maps rows normally', async () => {
    vi.mocked(getOrganizationBySlug).mockResolvedValue(org)
    vi.mocked(listProjectsByOrgIdAndIds).mockResolvedValue([
      { ...rowB, id: 10, organization_id: 1 },
    ])
    vi.mocked(countProjectsByOrgIdAndIds).mockResolvedValue(1)

    const result = await listOrgProjectsV2(DERIVED_CTX, 'acme')

    expect(result?.pagination).toEqual({ count: 1, limit: 100, offset: 0 })
    expect(result?.projects).toHaveLength(1)
    expect(result?.projects[0]).toMatchObject({ ref: 'proj-b', organization_slug: 'acme' })
  })
})

describe('listAllProjectsV2', () => {
  it('org-scoped member: maps each project to its organization slug via a single listOrganizations call', async () => {
    vi.mocked(listProjectsVisible).mockResolvedValue([rowA, rowB])
    vi.mocked(countProjectsVisible).mockResolvedValue(2)
    vi.mocked(listOrganizations).mockResolvedValue([
      { id: 1, slug: 'acme', name: 'Acme' },
      { id: 2, slug: 'other', name: 'Other' },
    ])

    const result = await listAllProjectsV2(ORG_CTX)

    expect(listProjectsVisible).toHaveBeenCalledWith([1], [], 100, 0)
    expect(countProjectsVisible).toHaveBeenCalledWith([1], [])
    expect(listOrganizations).toHaveBeenCalledTimes(1)
    expect(result.pagination).toEqual({ count: 2, limit: 100, offset: 0 })
    expect(result.projects).toEqual([
      expect.objectContaining({
        ref: 'proj-a',
        organization_slug: 'acme',
        preview_branch_refs: [],
        is_branch_enabled: false,
        subscription_id: null,
      }),
      expect.objectContaining({
        ref: 'proj-b',
        organization_slug: 'other',
        preview_branch_refs: [],
        is_branch_enabled: false,
        subscription_id: null,
      }),
    ])
  })

  it('passes limit/offset through to listProjectsVisible', async () => {
    vi.mocked(listProjectsVisible).mockResolvedValue([rowA])
    vi.mocked(countProjectsVisible).mockResolvedValue(1)
    vi.mocked(listOrganizations).mockResolvedValue([{ id: 1, slug: 'acme', name: 'Acme' }])

    await listAllProjectsV2(ORG_CTX, 25, 50)

    expect(listProjectsVisible).toHaveBeenCalledWith([1], [], 25, 50)
  })

  it('falls back to a single default project when the registry is empty (org-scoped, count 0)', async () => {
    vi.mocked(listProjectsVisible).mockResolvedValue([])
    vi.mocked(countProjectsVisible).mockResolvedValue(0)
    vi.mocked(listOrganizations).mockResolvedValue([])

    const result = await listAllProjectsV2(ORG_CTX)

    expect(result.pagination).toEqual({ count: 1, limit: 100, offset: 0 })
    expect(result.projects).toEqual([
      expect.objectContaining({
        ref: 'default',
        organization_slug: 'default',
        preview_branch_refs: [],
      }),
    ])
  })

  it('returns empty projects (but count 1) for an empty registry when offset >= 1', async () => {
    vi.mocked(listProjectsVisible).mockResolvedValue([])
    vi.mocked(countProjectsVisible).mockResolvedValue(0)
    vi.mocked(listOrganizations).mockResolvedValue([])

    const result = await listAllProjectsV2(ORG_CTX, 100, 1)

    expect(result.pagination).toEqual({ count: 1, limit: 100, offset: 1 })
    expect(result.projects).toEqual([])
  })

  it('derived-scope member: folds project ids (not org ids) into the visibility query', async () => {
    vi.mocked(listProjectsVisible).mockResolvedValue([])
    vi.mocked(countProjectsVisible).mockResolvedValue(0)
    vi.mocked(listOrganizations).mockResolvedValue([])

    await listAllProjectsV2(DERIVED_CTX)

    expect(listProjectsVisible).toHaveBeenCalledWith([], [10], 100, 0)
    expect(countProjectsVisible).toHaveBeenCalledWith([], [10])
  })

  it('zero-role member: fail-closed short-circuit issues NO SQL and NO default fallback', async () => {
    const result = await listAllProjectsV2(ZERO_CTX)

    expect(result).toEqual({ pagination: { count: 0, limit: 100, offset: 0 }, projects: [] })
    expect(listProjectsVisible).not.toHaveBeenCalled()
    expect(countProjectsVisible).not.toHaveBeenCalled()
    expect(listOrganizations).not.toHaveBeenCalled()
  })
})
