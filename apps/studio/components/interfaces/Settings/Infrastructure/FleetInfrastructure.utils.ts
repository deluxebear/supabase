import { t as $t } from '@/lib/i18n'

// [self-platform] Wording for runtime inventory that depends on how the
// project is deployed. Kubernetes reports PVC capacity but not usage.

export type InventoryAdapter = 'compose' | 'kubernetes'

const RUNTIME_STATUSES: Record<string, string> = {
  healthy: 'Healthy',
  unhealthy: 'Unhealthy',
  running: 'Running',
  exited: 'Exited',
  starting: 'Starting',
  created: 'Created',
  restarting: 'Restarting',
  paused: 'Paused',
  dead: 'Dead',
  removing: 'Removing',
  passed: 'Passed',
  failed: 'Failed',
  blocked: 'Blocked',
  idle: 'Idle',
  'not-configured': 'Not configured',
  unknown: 'Unknown',
}

export function formatRuntimeStatus(status: string): string {
  return $t(RUNTIME_STATUSES[status] ?? status)
}

const PREFLIGHT_CHECKS: Record<string, string> = {
  inventory_fresh: 'Inventory freshness',
  disk_headroom: 'Recovery storage capacity',
  provider_registration: 'Upgrade provider registration',
}

export function formatPreflightCheck(code: string): string {
  return $t(PREFLIGHT_CHECKS[code] ?? code)
}

export function getInventoryCopy(adapter: InventoryAdapter) {
  if (adapter === 'kubernetes') {
    return {
      description: $t(
        'Observed by the project Agent from the Kubernetes namespace and PostgreSQL runtime.'
      ),
      workloadsTitle: $t('Kubernetes pods and volumes'),
    }
  }
  return {
    description: $t('Observed by the project Agent from the Compose host and PostgreSQL runtime.'),
    workloadsTitle: $t('Compose containers and volumes'),
  }
}

const COMPUTE_SOURCES: Record<string, () => string> = {
  'compose-host-pool': () => $t('Compose host'),
  'kubernetes-namespace-quota': () => $t('Namespace resource quota'),
  'kubernetes-node-allocatable': () => $t('Database node allocatable'),
}

/** Names where the compute capacity comes from; unknown sources pass through. */
export function formatComputeSource(source: string): string {
  return COMPUTE_SOURCES[source]?.() ?? source
}

/**
 * Describes a volume's usage. Kubernetes does not report PVC usage to the
 * Agent, so its volumes show the storage class instead of a misleading 0 B.
 */
export function formatVolumeUsage(
  adapter: InventoryAdapter,
  volume: { driver: string; usedBytes: number },
  formatBytes: (value: number) => string
): string {
  if (adapter === 'kubernetes') {
    return $t('{{storageClass}} · usage not reported', { storageClass: volume.driver })
  }
  return formatBytes(volume.usedBytes)
}
