import { beforeEach, describe, expect, it, vi } from 'vitest'

import { listAllProjectsV2, listOrgProjectsV2 } from './list-user-projects'
import { getOrganizationBySlug, listOrganizations } from './organizations'
import { listAllProjects, listProjectsByOrgId } from './projects'

vi.mock('./organizations', () => ({
  getOrganizationBySlug: vi.fn(),
  listOrganizations: vi.fn(),
}))
vi.mock('./projects', () => ({
  listAllProjects: vi.fn(),
  listProjectsByOrgId: vi.fn(),
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
}

const rowB = {
  ...rowA,
  id: 2,
  ref: 'proj-b',
  name: 'Project B',
  organization_id: 2,
  region: 'us-west-2',
}

beforeEach(() => vi.clearAllMocks())

describe('listOrgProjectsV2', () => {
  it('lists two registered projects for an org', async () => {
    vi.mocked(getOrganizationBySlug).mockResolvedValue(org)
    vi.mocked(listProjectsByOrgId).mockResolvedValue([rowA, { ...rowB, organization_id: 1 }])

    const result = await listOrgProjectsV2('acme')

    expect(getOrganizationBySlug).toHaveBeenCalledWith('acme')
    expect(listProjectsByOrgId).toHaveBeenCalledWith(1)
    expect(result?.pagination).toEqual({ count: 2, limit: 100, offset: 0 })
    expect(result?.projects).toHaveLength(2)
    expect(result?.projects[0]).toMatchObject({
      ref: 'proj-a',
      name: 'Project A',
      organization_id: 1,
      organization_slug: 'acme',
      is_branch: false,
      preview_branch_refs: [],
      databases: [
        { identifier: 'proj-a', region: 'us-east-1', status: 'ACTIVE_HEALTHY', type: 'PRIMARY' },
      ],
    })
    expect(result?.projects[1]).toMatchObject({ ref: 'proj-b', organization_slug: 'acme' })
  })

  it('falls back to the single default project when the org has no registered projects', async () => {
    vi.mocked(getOrganizationBySlug).mockResolvedValue(org)
    vi.mocked(listProjectsByOrgId).mockResolvedValue([])

    const result = await listOrgProjectsV2('acme')

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

  it('returns null when the org is not found', async () => {
    vi.mocked(getOrganizationBySlug).mockResolvedValue(null)

    expect(await listOrgProjectsV2('nope')).toBeNull()
    expect(listProjectsByOrgId).not.toHaveBeenCalled()
  })

  it('passes through limit/offset into pagination', async () => {
    vi.mocked(getOrganizationBySlug).mockResolvedValue(org)
    vi.mocked(listProjectsByOrgId).mockResolvedValue([rowA])

    const result = await listOrgProjectsV2('acme', 50, 10)

    expect(result?.pagination).toEqual({ count: 1, limit: 50, offset: 10 })
  })
})

describe('listAllProjectsV2', () => {
  it('maps each project to its organization slug via a single listOrganizations call', async () => {
    vi.mocked(listAllProjects).mockResolvedValue([rowA, rowB])
    vi.mocked(listOrganizations).mockResolvedValue([
      { id: 1, slug: 'acme', name: 'Acme' },
      { id: 2, slug: 'other', name: 'Other' },
    ])

    const result = await listAllProjectsV2()

    expect(listOrganizations).toHaveBeenCalledTimes(1)
    expect(result.pagination).toEqual({ count: 2, limit: 100, offset: 0 })
    expect(result.projects).toEqual([
      expect.objectContaining({
        ref: 'proj-a',
        organization_slug: 'acme',
        preview_branch_refs: [],
      }),
      expect.objectContaining({
        ref: 'proj-b',
        organization_slug: 'other',
        preview_branch_refs: [],
      }),
    ])
  })

  it('falls back to a single default project when the registry is empty', async () => {
    vi.mocked(listAllProjects).mockResolvedValue([])
    vi.mocked(listOrganizations).mockResolvedValue([])

    const result = await listAllProjectsV2()

    expect(result.pagination).toEqual({ count: 1, limit: 100, offset: 0 })
    expect(result.projects).toEqual([
      expect.objectContaining({
        ref: 'default',
        organization_slug: 'default',
        preview_branch_refs: [],
      }),
    ])
  })
})
