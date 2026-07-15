export type StudioDeploymentProfile = 'cloud' | 'embedded' | 'fleet' | 'cli'

export interface StudioCapabilities {
  multiProject: boolean
  platformIdentity: boolean
  localFunctionsDirectory: boolean
  remoteFunctionsDeployment: boolean
  runtimeConfiguration: boolean
  lifecycleManagement: boolean
  backupManagement: boolean
  cloudManagementApi: boolean
  projectAttachment: boolean
  managementTrust: boolean
  ownershipReconciliation: boolean
}

export interface StudioDeploymentProfileEnvironment {
  canonicalProfile?: string
  isPlatform?: string
  isSelfPlatform?: string
  currentCliVersion?: string
}

const VALID_PROFILES: ReadonlyArray<StudioDeploymentProfile> = ['cloud', 'embedded', 'fleet', 'cli']

const PROFILE_CAPABILITIES: Record<StudioDeploymentProfile, StudioCapabilities> = {
  cloud: {
    multiProject: true,
    platformIdentity: true,
    localFunctionsDirectory: false,
    remoteFunctionsDeployment: true,
    runtimeConfiguration: true,
    lifecycleManagement: true,
    backupManagement: true,
    cloudManagementApi: true,
    projectAttachment: false,
    managementTrust: false,
    ownershipReconciliation: false,
  },
  embedded: {
    multiProject: false,
    platformIdentity: false,
    localFunctionsDirectory: true,
    remoteFunctionsDeployment: false,
    runtimeConfiguration: false,
    lifecycleManagement: false,
    backupManagement: false,
    cloudManagementApi: false,
    projectAttachment: false,
    managementTrust: false,
    ownershipReconciliation: false,
  },
  fleet: {
    multiProject: true,
    platformIdentity: true,
    localFunctionsDirectory: false,
    remoteFunctionsDeployment: true,
    runtimeConfiguration: false,
    lifecycleManagement: false,
    backupManagement: false,
    cloudManagementApi: false,
    projectAttachment: true,
    managementTrust: true,
    ownershipReconciliation: true,
  },
  cli: {
    multiProject: false,
    platformIdentity: false,
    localFunctionsDirectory: true,
    remoteFunctionsDeployment: false,
    runtimeConfiguration: false,
    lifecycleManagement: false,
    backupManagement: false,
    cloudManagementApi: false,
    projectAttachment: false,
    managementTrust: false,
    ownershipReconciliation: false,
  },
}

const isTrue = (value: string | undefined) => value === 'true'

function describeValue(value: string | undefined) {
  return value === undefined || value === '' ? '<unset>' : JSON.stringify(value)
}

function assertCanonicalProfile(value: string): asserts value is StudioDeploymentProfile {
  if (!VALID_PROFILES.includes(value as StudioDeploymentProfile)) {
    throw new Error(
      `Invalid NEXT_PUBLIC_STUDIO_DEPLOYMENT_PROFILE=${describeValue(value)}. ` +
        `Expected one of: ${VALID_PROFILES.join(', ')}.`
    )
  }
}

function assertLegacyCompatibility(
  profile: StudioDeploymentProfile,
  environment: StudioDeploymentProfileEnvironment
) {
  const hasPlatformFlag = environment.isPlatform !== undefined && environment.isPlatform !== ''
  const hasSelfPlatformFlag =
    environment.isSelfPlatform !== undefined && environment.isSelfPlatform !== ''
  const isPlatform = isTrue(environment.isPlatform)
  const isSelfPlatform = isTrue(environment.isSelfPlatform)

  const expectedPlatform = profile === 'cloud' || profile === 'fleet'
  const expectedSelfPlatform = profile === 'fleet'

  if (
    (hasPlatformFlag && isPlatform !== expectedPlatform) ||
    (hasSelfPlatformFlag && isSelfPlatform !== expectedSelfPlatform)
  ) {
    throw new Error(
      `Studio deployment profile conflict: NEXT_PUBLIC_STUDIO_DEPLOYMENT_PROFILE=${JSON.stringify(profile)}, ` +
        `NEXT_PUBLIC_IS_PLATFORM=${describeValue(environment.isPlatform)}, ` +
        `NEXT_PUBLIC_SELF_PLATFORM=${describeValue(environment.isSelfPlatform)}.`
    )
  }
}

export function resolveStudioDeploymentProfile(
  environment: StudioDeploymentProfileEnvironment
): StudioDeploymentProfile {
  const canonicalProfile = environment.canonicalProfile?.trim()

  if (canonicalProfile !== undefined && canonicalProfile !== '') {
    assertCanonicalProfile(canonicalProfile)
    assertLegacyCompatibility(canonicalProfile, environment)
    return canonicalProfile
  }

  const isPlatform = isTrue(environment.isPlatform)
  const isSelfPlatform = isTrue(environment.isSelfPlatform)

  if (isSelfPlatform && !isPlatform) {
    throw new Error(
      `Invalid legacy Studio deployment flags: NEXT_PUBLIC_IS_PLATFORM=${describeValue(environment.isPlatform)}, ` +
        `NEXT_PUBLIC_SELF_PLATFORM=${describeValue(environment.isSelfPlatform)}. ` +
        'NEXT_PUBLIC_SELF_PLATFORM=true requires NEXT_PUBLIC_IS_PLATFORM=true.'
    )
  }

  if (isSelfPlatform) return 'fleet'
  if (isPlatform) return 'cloud'
  if (environment.currentCliVersion) return 'cli'
  return 'embedded'
}

export function getStudioCapabilities(profile: StudioDeploymentProfile): StudioCapabilities {
  return PROFILE_CAPABILITIES[profile]
}

export const STUDIO_DEPLOYMENT_PROFILE = resolveStudioDeploymentProfile({
  canonicalProfile: process.env.NEXT_PUBLIC_STUDIO_DEPLOYMENT_PROFILE,
  isPlatform: process.env.NEXT_PUBLIC_IS_PLATFORM,
  isSelfPlatform: process.env.NEXT_PUBLIC_SELF_PLATFORM,
  currentCliVersion: process.env.CURRENT_CLI_VERSION,
})

export const STUDIO_CAPABILITIES = getStudioCapabilities(STUDIO_DEPLOYMENT_PROFILE)

if (
  typeof window === 'undefined' &&
  !process.env.NEXT_PUBLIC_STUDIO_DEPLOYMENT_PROFILE &&
  process.env.NODE_ENV !== 'test'
) {
  console.warn(
    `[studio] NEXT_PUBLIC_STUDIO_DEPLOYMENT_PROFILE is unset; resolved legacy deployment profile ` +
      `${JSON.stringify(STUDIO_DEPLOYMENT_PROFILE)}. Set the canonical build-time profile.`
  )
}
