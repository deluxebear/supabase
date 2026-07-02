import { describe, expect, it, vi } from 'vitest'

import { executePlatformQuery } from './db'
import {
  getOrganizationBySlug,
  listOrganizations,
  toOrganizationResponse,
  toOrganizationSlugResponse,
} from './organizations'

vi.mock('./db', () => ({ executePlatformQuery: vi.fn() }))

const row = { id: 1, slug: 'default', name: 'Default Organization' }

describe('toOrganizationResponse', () => {
  it('produces the OrganizationResponse contract with enterprise plan', () => {
    expect(toOrganizationResponse(row)).toMatchObject({
      id: 1,
      slug: 'default',
      name: 'Default Organization',
      is_owner: true,
      plan: { id: 'enterprise', name: 'Enterprise' },
      opt_in_tags: [],
      billing_email: null,
      restriction_status: null,
    })
  })
})

describe('toOrganizationSlugResponse', () => {
  it('includes has_oriole_project and drops list-only fields', () => {
    const res = toOrganizationSlugResponse(row)
    expect(res).toMatchObject({ slug: 'default', has_oriole_project: false })
    expect('is_owner' in res).toBe(false)
  })
})

describe('queries', () => {
  it('listOrganizations selects all rows', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({ data: [row], error: undefined })
    expect(await listOrganizations()).toEqual([row])
  })

  it('getOrganizationBySlug binds the slug parameter', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({ data: [], error: undefined })
    expect(await getOrganizationBySlug('default')).toBeNull()
    const call = vi.mocked(executePlatformQuery).mock.calls.at(-1)![0]
    expect(call.parameters).toEqual(['default'])
  })
})
