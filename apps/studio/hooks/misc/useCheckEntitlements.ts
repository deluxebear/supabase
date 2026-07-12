import { useCallback, useMemo } from 'react'

import { useSelectedOrganizationQuery } from './useSelectedOrganization'
import type {
  Entitlement,
  EntitlementConfig,
  EntitlementType,
  FeatureKey,
} from '@/data/entitlements/entitlements-query'
import { useEntitlementsQuery } from '@/data/entitlements/entitlements-query'
import { IS_PLATFORM } from '@/lib/constants'
import { IS_SELF_PLATFORM } from '@/lib/constants/self-platform'

// [self-platform] Feature gating is entitlement-based, but self-platform's
// entitlements endpoint is a contract-minimal stub (only a couple of keys),
// so most `useCheckEntitlements('...')` calls would resolve to hasAccess=false
// and show a nonsensical "Upgrade to Pro" on an operator-owned stack. Treat
// self-platform like plain self-hosted here: you own the infrastructure, so
// every feature is granted (same permissive branch as IS_PLATFORM=false).
const CHECK_ENTITLEMENTS = IS_PLATFORM && !IS_SELF_PLATFORM

function isNumericConfig(
  _config: EntitlementConfig,
  type: EntitlementType
): _config is { enabled: boolean; unlimited: boolean; value: number } {
  return type === 'numeric'
}

function isSetConfig(
  _config: EntitlementConfig,
  type: EntitlementType
): _config is { enabled: boolean; set: string[] } {
  return type === 'set'
}

function getEntitlementNumericValue(entitlement: Entitlement | null): number | undefined {
  const entitlementConfig = entitlement?.config
  return entitlementConfig &&
    entitlement.type &&
    isNumericConfig(entitlementConfig, entitlement.type)
    ? entitlementConfig.value
    : undefined
}

function isEntitlementUnlimited(entitlement: Entitlement | null): boolean {
  const entitlementConfig = entitlement?.config
  return entitlementConfig &&
    entitlement.type &&
    isNumericConfig(entitlementConfig, entitlement.type)
    ? entitlementConfig.unlimited
    : false
}

function getEntitlementSetValues(entitlement: Entitlement | null): string[] {
  const entitlementConfig = entitlement?.config
  return entitlementConfig && entitlement.type && isSetConfig(entitlementConfig, entitlement.type)
    ? entitlementConfig.set
    : []
}

function getEntitlementMax(entitlement: Entitlement | null): number | undefined {
  return isEntitlementUnlimited(entitlement)
    ? Number.MAX_SAFE_INTEGER
    : getEntitlementNumericValue(entitlement)
}

export function useHasEntitlementAccess(organizationSlug?: string) {
  const shouldGetSelectedOrg = !organizationSlug
  const { data: selectedOrg } = useSelectedOrganizationQuery({
    enabled: shouldGetSelectedOrg,
  })

  const finalOrgSlug = organizationSlug || selectedOrg?.slug
  const enabled = IS_PLATFORM && !!finalOrgSlug

  const { data: entitlementsData } = useEntitlementsQuery({ slug: finalOrgSlug! }, { enabled })

  return useCallback(
    (key: string) =>
      CHECK_ENTITLEMENTS
        ? (entitlementsData?.entitlements?.find((e) => e.feature.key === key)?.hasAccess ?? false)
        : true,
    [entitlementsData]
  )
}

export function useCheckEntitlements(
  featureKey: FeatureKey,
  organizationSlug?: string,
  options?: {
    enabled?: boolean
  }
) {
  // If no organizationSlug provided, try to get it from the selected organization
  const shouldGetSelectedOrg = !organizationSlug && options?.enabled !== false
  const {
    data: selectedOrg,
    isPending: isLoadingSelectedOrg,
    isSuccess: isSuccessSelectedOrg,
  } = useSelectedOrganizationQuery({
    enabled: shouldGetSelectedOrg,
  })

  const finalOrgSlug = organizationSlug || selectedOrg?.slug
  const enabled = IS_PLATFORM ? options?.enabled !== false && !!finalOrgSlug : false

  const {
    data: entitlementsData,
    isPending: isLoadingEntitlements,
    isSuccess: isSuccessEntitlements,
  } = useEntitlementsQuery({ slug: finalOrgSlug! }, { enabled })

  const { entitlement } = useMemo((): {
    entitlement: Entitlement | null
  } => {
    // If no organization slug, no access
    if (!finalOrgSlug) return { entitlement: null }

    const entitlement = entitlementsData?.entitlements?.find(
      (entitlement) => entitlement.feature.key === featureKey
    )

    return {
      entitlement: entitlement ?? null,
    }
  }, [entitlementsData, featureKey, finalOrgSlug])

  const isLoading = shouldGetSelectedOrg
    ? isLoadingSelectedOrg || isLoadingEntitlements
    : isLoadingEntitlements
  const isSuccess = shouldGetSelectedOrg
    ? isSuccessSelectedOrg && isSuccessEntitlements
    : isSuccessEntitlements

  return {
    hasAccess: CHECK_ENTITLEMENTS ? (entitlement?.hasAccess ?? false) : true,
    isLoading: CHECK_ENTITLEMENTS ? isLoading : false,
    isSuccess: CHECK_ENTITLEMENTS ? isSuccess : true,
    getEntitlementNumericValue: () => getEntitlementNumericValue(entitlement),
    isEntitlementUnlimited: () => isEntitlementUnlimited(entitlement),
    getEntitlementSetValues: () => getEntitlementSetValues(entitlement),
    getEntitlementMax: () => getEntitlementMax(entitlement),
  }
}
