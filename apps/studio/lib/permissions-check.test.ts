import { describe, expect, it } from 'vitest'

import { doPermissionsCheck, type PermissionGrant } from './permissions-check'

const grant = (over: Partial<PermissionGrant>): PermissionGrant => ({
  actions: ['%'],
  condition: null,
  organization_slug: 'default',
  project_refs: [],
  resources: ['%'],
  restrictive: false,
  ...over,
})

describe('doPermissionsCheck (server-consumable evaluator)', () => {
  it('wildcard grant allows any action/resource on the org', () => {
    expect(
      doPermissionsCheck([grant({})], 'write:Create', 'user_invites', undefined, 'default')
    ).toBe(true)
  })

  it('returns false with no permissions / empty permissions', () => {
    expect(doPermissionsCheck(undefined, 'read:Read', 'projects', undefined, 'default')).toBe(false)
    expect(doPermissionsCheck([], 'read:Read', 'projects', undefined, 'default')).toBe(false)
  })

  it('wildcard patterns anchor and expand % on the grant side', () => {
    const g = [grant({ actions: ['write:%'], resources: ['organizations'] })]
    expect(doPermissionsCheck(g, 'write:Update', 'organizations', undefined, 'default')).toBe(true)
    expect(doPermissionsCheck(g, 'read:Read', 'organizations', undefined, 'default')).toBe(false)
    expect(doPermissionsCheck(g, 'write:Update', 'organizations_x', undefined, 'default')).toBe(
      false
    )
  })

  it('restrictive grants win over permissive ones (deny-first)', () => {
    const g = [
      grant({}),
      grant({ actions: ['write:%'], resources: ['organizations'], restrictive: true }),
    ]
    expect(doPermissionsCheck(g, 'write:Update', 'organizations', undefined, 'default')).toBe(false)
    expect(doPermissionsCheck(g, 'read:Read', 'organizations', undefined, 'default')).toBe(true)
  })

  it('json-logic conditions receive resource_name plus caller data', () => {
    const g = [
      grant({}),
      grant({
        actions: ['write:Create', 'write:Delete'],
        resources: ['user_invites', 'auth.subject_roles'],
        restrictive: true,
        condition: { '==': [{ var: 'resource.role_id' }, 1] },
      }),
    ]
    expect(
      doPermissionsCheck(g, 'write:Create', 'user_invites', { resource: { role_id: 1 } }, 'default')
    ).toBe(false)
    expect(
      doPermissionsCheck(g, 'write:Create', 'user_invites', { resource: { role_id: 3 } }, 'default')
    ).toBe(true)
  })

  it('project-scoped grants match only their refs, then fall back to org grants', () => {
    const scoped = grant({ actions: ['read:Read'], project_refs: ['proj-b'] })
    expect(
      doPermissionsCheck([scoped], 'read:Read', 'projects', undefined, 'default', 'proj-b')
    ).toBe(true)
    // different ref: scoped grant filtered out, no org-level grant -> false
    expect(
      doPermissionsCheck([scoped], 'read:Read', 'projects', undefined, 'default', 'default')
    ).toBe(false)
  })

  it('organization slug must match', () => {
    expect(doPermissionsCheck([grant({})], 'read:Read', 'projects', undefined, 'other-org')).toBe(
      false
    )
  })

  it('tolerates null actions/resources (AccessControlPermission shape)', () => {
    expect(
      doPermissionsCheck(
        [grant({ actions: null, resources: null })],
        'read:Read',
        'projects',
        undefined,
        'default'
      )
    ).toBe(false)
  })
})
