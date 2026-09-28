import { describe, expect, it } from 'vitest'

import {
  getStudioCapabilities,
  resolveStudioDeploymentProfile,
  type StudioDeploymentProfileEnvironment,
} from '@/lib/constants/deployment-profile'

describe('resolveStudioDeploymentProfile', () => {
  it.each([
    ['cloud', 'true', undefined],
    ['embedded', 'false', 'false'],
    ['embedded', undefined, undefined],
    ['fleet', 'true', 'true'],
    ['cli', 'false', undefined],
  ] satisfies Array<[string, string | undefined, string | undefined]>)(
    'resolves canonical %s with compatible legacy flags',
    (canonicalProfile, isPlatform, isSelfPlatform) => {
      expect(resolveStudioDeploymentProfile({ canonicalProfile, isPlatform, isSelfPlatform })).toBe(
        canonicalProfile
      )
    }
  )

  it.each([
    [{ canonicalProfile: 'cloud', isPlatform: 'false' }],
    [{ canonicalProfile: 'cloud', isSelfPlatform: 'true' }],
    [{ canonicalProfile: 'embedded', isPlatform: 'true' }],
    [{ canonicalProfile: 'fleet', isPlatform: 'false', isSelfPlatform: 'true' }],
    [{ canonicalProfile: 'fleet', isPlatform: 'true', isSelfPlatform: 'false' }],
    [{ canonicalProfile: 'cli', isPlatform: 'true' }],
  ] satisfies Array<[StudioDeploymentProfileEnvironment]>)(
    'rejects canonical and legacy conflicts: %j',
    (environment) => {
      expect(() => resolveStudioDeploymentProfile(environment)).toThrow(
        /Studio deployment profile conflict/
      )
    }
  )

  it('rejects an unknown canonical profile', () => {
    expect(() => resolveStudioDeploymentProfile({ canonicalProfile: 'serverless' })).toThrow(
      /Invalid NEXT_PUBLIC_STUDIO_DEPLOYMENT_PROFILE/
    )
  })

  it.each([
    [{ isPlatform: 'true', isSelfPlatform: 'true' }, 'fleet'],
    [{ isPlatform: 'true' }, 'cloud'],
    [{ isPlatform: 'false', isSelfPlatform: 'false' }, 'embedded'],
    [{ currentCliVersion: '2.50.0' }, 'cli'],
    [{}, 'embedded'],
  ] satisfies Array<[StudioDeploymentProfileEnvironment, string]>)(
    'maps legacy inputs %j to %s',
    (environment, expected) => {
      expect(resolveStudioDeploymentProfile(environment)).toBe(expected)
    }
  )

  it('rejects legacy self-platform without platform', () => {
    expect(() =>
      resolveStudioDeploymentProfile({ isPlatform: 'false', isSelfPlatform: 'true' })
    ).toThrow(/NEXT_PUBLIC_SELF_PLATFORM=true requires NEXT_PUBLIC_IS_PLATFORM=true/)
  })
})

describe('getStudioCapabilities', () => {
  it('keeps Embedded and CLI on the local single-project contract', () => {
    expect(getStudioCapabilities('embedded')).toMatchObject({
      multiProject: false,
      platformIdentity: false,
      localFunctionsDirectory: true,
      cloudManagementApi: false,
      managementTrust: false,
      ownershipReconciliation: false,
    })
    expect(getStudioCapabilities('cli')).toEqual(getStudioCapabilities('embedded'))
  })

  it('exposes only implemented Fleet runtime capabilities', () => {
    expect(getStudioCapabilities('fleet')).toMatchObject({
      multiProject: true,
      platformIdentity: true,
      remoteFunctionsDeployment: true,
      runtimeConfiguration: true,
      lifecycleManagement: true,
      backupManagement: true,
      cloudManagementApi: false,
      managementTrust: true,
      ownershipReconciliation: true,
      hostedBilling: false,
      hostedOrganizationUsage: false,
      hostedMarketplaceIntegrations: false,
      hostedIncidentStatus: false,
      hostedConsent: false,
      hostedTelemetry: false,
      hostedFeatureFlags: false,
      previewBranching: false,
      etlReplication: false,
      storageAnalytics: false,
      storageVectors: false,
      dedicatedIPv4: false,
    })
  })

  it('reports Auth settings as applied only where saving reaches the Auth service', () => {
    expect(getStudioCapabilities('cloud').appliedAuthConfiguration).toBe(true)
    expect(getStudioCapabilities('fleet').appliedAuthConfiguration).toBe(false)
    expect(getStudioCapabilities('embedded').appliedAuthConfiguration).toBe(false)
  })

  it('keeps hosted management capabilities cloud-only', () => {
    expect(getStudioCapabilities('cloud').cloudManagementApi).toBe(true)
    expect(getStudioCapabilities('fleet').cloudManagementApi).toBe(false)
    expect(getStudioCapabilities('embedded').managementTrust).toBe(false)
  })

  it('keeps hosted services and paid Cloud entitlements cloud-only', () => {
    expect(getStudioCapabilities('cloud')).toMatchObject({
      hostedBilling: true,
      hostedOrganizationUsage: true,
      hostedMarketplaceIntegrations: true,
      hostedIncidentStatus: true,
      hostedConsent: true,
      hostedTelemetry: true,
      hostedFeatureFlags: true,
      previewBranching: true,
      etlReplication: true,
      storageAnalytics: true,
      storageVectors: true,
      dedicatedIPv4: true,
    })
  })
})
