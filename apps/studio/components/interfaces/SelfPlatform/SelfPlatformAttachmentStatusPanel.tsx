import { useQuery } from '@tanstack/react-query'
import { Alert, AlertDescription, Badge } from 'ui'
import {
  PageSection,
  PageSectionContent,
  PageSectionMeta,
  PageSectionSummary,
  PageSectionTitle,
} from 'ui-patterns/PageSection'
import { GenericSkeletonLoader } from 'ui-patterns/ShimmeringLoader'

import {
  findProjectCapability,
  projectCapabilitiesQueryOptions,
} from '@/data/projects/project-capabilities-query'
import type { SelfPlatformProjectBlock } from '@/data/projects/self-platform-project-update-mutation'
import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'
import { t as $t } from '@/lib/i18n'

const statusVariant = (value: string) => {
  if (['active', 'healthy', 'online', 'in-sync', 'idle', 'verified'].includes(value)) {
    return 'success' as const
  }
  if (['detached', 'failed', 'unreachable', 'revoked', 'manual-intervention'].includes(value)) {
    return 'destructive' as const
  }
  return 'warning' as const
}

export const SelfPlatformAttachmentStatusPanel = () => {
  const { data: project } = useSelectedProjectQuery()
  const selfPlatform = (
    project as unknown as { self_platform?: SelfPlatformProjectBlock } | undefined
  )?.self_platform
  const capabilities = useQuery(projectCapabilitiesQueryOptions({ projectRef: project?.ref }))

  if (!project || !selfPlatform) return null
  if (capabilities.isPending) return <GenericSkeletonLoader />

  const status = selfPlatform.attachment
  const statusCapability = findProjectCapability(capabilities.data, 'project.status.read')
  if (capabilities.isError) {
    return (
      <Alert variant="warning">
        <AlertDescription>
          {$t('Failed to load Fleet project capabilities: {{message}}', {
            message: capabilities.error.message,
          })}
        </AlertDescription>
      </Alert>
    )
  }
  if (!status || statusCapability?.state !== 'available') {
    return (
      <Alert variant="warning">
        <AlertDescription>
          {statusCapability?.blockers[0]?.message ??
            $t('Attachment status is unavailable for this project.')}
        </AlertDescription>
      </Alert>
    )
  }

  const dimensions = [
    [$t('Attachment'), status.attachmentState],
    [$t('Data plane'), status.dataPlaneHealth],
    [$t('Management'), status.managementConnectivity],
    [$t('Drift'), status.driftState],
    [$t('Operations'), status.operationState],
    [$t('Identity proof'), status.fingerprintProofState],
  ] as const

  return (
    <PageSection id="attachment-status">
      <PageSectionMeta>
        <PageSectionSummary>
          <PageSectionTitle>{$t('Fleet attachment status')}</PageSectionTitle>
        </PageSectionSummary>
      </PageSectionMeta>
      <PageSectionContent className="space-y-4">
        {status.fingerprintProofState === 'unverified' && (
          <Alert variant="warning">
            <AlertDescription>
              {$t(
                'This project predates stack identity proof. Save its connection configuration to run the full preflight and verify the binding.'
              )}
            </AlertDescription>
          </Alert>
        )}
        <div className="grid gap-3 md:grid-cols-2">
          {dimensions.map(([label, value]) => (
            <div key={label} className="flex items-center justify-between rounded border p-3">
              <span className="text-sm text-foreground-light">{label}</span>
              <Badge variant={statusVariant(value)}>{value}</Badge>
            </div>
          ))}
        </div>
        <p className="text-xs text-foreground-lighter">
          {$t('Connection revision {{revision}} · observed {{observedAt}}', {
            revision: status.activeConnectionRevision,
            observedAt: status.statusObservedAt,
          })}
        </p>
      </PageSectionContent>
    </PageSection>
  )
}
