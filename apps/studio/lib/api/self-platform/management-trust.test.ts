import { beforeEach, describe, expect, it, vi } from 'vitest'

import { executePlatformQuery } from './db'
import {
  createManagementTarget,
  enrollmentTokenAuditQuery,
  managementBindingInputSchema,
  managementTargetInputSchema,
  mintManagementServiceAssertion,
} from './management-trust'

vi.mock('./db', () => ({ executePlatformQuery: vi.fn() }))

describe('management trust platform boundary', () => {
  beforeEach(() => vi.clearAllMocks())

  it('accepts only HTTPS domains and server-side secret references', () => {
    const base = {
      name: 'Primary',
      trustDomain: 'primary.fleet.internal',
      caReference: 'file:/run/secrets/fleet-management/ca.crt',
      assertionKeyReference: 'env:FLEET_MANAGEMENT_ASSERTION_PRIMARY',
      domains: [
        {
          domain: 'fleet-control' as const,
          apiUrl: 'https://fleet-control:8091',
          audience: 'fleet-control',
          contractVersion: 'v1',
          capabilitySchemaPrefix: 'supabase.fleet.',
        },
      ],
    }
    expect(managementTargetInputSchema.safeParse(base).success).toBe(true)
    expect(
      managementTargetInputSchema.safeParse({
        ...base,
        assertionKeyReference: 'plain-text-secret',
      }).success
    ).toBe(false)
    expect(
      managementTargetInputSchema.safeParse({
        ...base,
        domains: [{ ...base.domains[0], apiUrl: 'http://fleet-control:8090' }],
      }).success
    ).toBe(false)
  })

  it('reserves platform management capabilities from Agent projection', () => {
    expect(
      managementBindingInputSchema.safeParse({
        managementTargetId: '00000000-0000-4000-8000-00000000000a',
        executionTarget: 'compose://project-a',
        deploymentKind: 'compose',
        allowedCapabilityPrefixes: ['management.'],
      }).success
    ).toBe(false)
  })

  it('types enrollment audit parameters that PostgreSQL cannot infer from JSON builders', () => {
    expect(enrollmentTokenAuditQuery).toContain("'enrollment_id', $5::text")
    expect(enrollmentTokenAuditQuery).toContain("'expires_at', $6::timestamptz")
  })

  it('mints a short project-scoped assertion without secret material in claims', () => {
    const token = mintManagementServiceAssertion({
      key: '01234567890123456789012345678901',
      issuer: 'studio-platform',
      audience: 'fleet-a',
      subject: 'owner-a',
      projectRef: 'project-a',
      scopes: ['fleet.read'],
      organizationId: 'org-a',
      bindingId: 'binding-a',
      requestId: 'request-a',
      aal: 'aal2',
      aalAuthenticatedAt: 1_768_435_200,
    })
    const claims = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
    expect(claims).toMatchObject({
      iss: 'studio-platform',
      aud: 'fleet-a',
      sub: 'owner-a',
      projects: ['project-a'],
      scopes: ['fleet.read'],
      organization_id: 'org-a',
      binding_id: 'binding-a',
      request_id: 'request-a',
      aal: 'aal2',
      aal_authenticated_at: 1_768_435_200,
    })
    expect(claims.exp - claims.nbf).toBeLessThanOrEqual(65)
    expect(claims.jti).toMatch(/^[0-9a-f-]{36}$/)
    expect(JSON.stringify(claims)).not.toContain('0123456789')
  })

  it('persists references and domain contracts, never resolved key bytes', async () => {
    vi.mocked(executePlatformQuery)
      .mockResolvedValueOnce({ data: [{ id: '00000000-0000-4000-8000-00000000000a' }] } as never)
      .mockResolvedValueOnce({
        data: [
          {
            id: '00000000-0000-4000-8000-00000000000a',
            organization_id: 1,
            name: 'Primary',
            trust_domain: 'primary.fleet.internal',
            ca_reference: 'file:/run/secrets/fleet-management/ca.crt',
            assertion_key_reference: 'env:FLEET_MANAGEMENT_ASSERTION_PRIMARY',
            state: 'active',
            created_at: '2026-07-15 00:00:00.123456+00',
            updated_at: '2026-07-15 00:00:01.654321+00',
            domains: [
              {
                domain: 'fleet-control',
                apiUrl: 'https://fleet-control:8091',
                audience: 'fleet-control',
                contractVersion: 'v1',
                capabilitySchemaPrefix: 'supabase.fleet.',
                targetVersion: null,
                state: 'unverified',
                observedAt: '2026-07-15 00:00:02.987654+00',
              },
            ],
          },
        ],
      } as never)

    const target = await createManagementTarget({
      organizationId: 1,
      actor: 'owner-a',
      target: {
        name: 'Primary',
        trustDomain: 'primary.fleet.internal',
        caReference: 'file:/run/secrets/fleet-management/ca.crt',
        assertionKeyReference: 'env:FLEET_MANAGEMENT_ASSERTION_PRIMARY',
        domains: [
          {
            domain: 'fleet-control',
            apiUrl: 'https://fleet-control:8091',
            audience: 'fleet-control',
            contractVersion: 'v1',
            capabilitySchemaPrefix: 'supabase.fleet.',
          },
        ],
      },
    })
    const parameters = vi.mocked(executePlatformQuery).mock.calls[0][0].parameters
    expect(parameters).toContain('env:FLEET_MANAGEMENT_ASSERTION_PRIMARY')
    expect(JSON.stringify(parameters)).not.toContain('resolved-secret')
    expect(target.createdAt).toBe('2026-07-15T00:00:00.123Z')
    expect(target.updatedAt).toBe('2026-07-15T00:00:01.654Z')
    expect(target.domains[0].observedAt).toBe('2026-07-15T00:00:02.987Z')
  })
})
