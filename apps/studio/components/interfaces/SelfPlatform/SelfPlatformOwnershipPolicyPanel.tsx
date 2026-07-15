import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from 'ui'
import { GenericSkeletonLoader } from 'ui-patterns/ShimmeringLoader'

import { AlertError } from '@/components/ui/AlertError'
import {
  findProjectCapability,
  projectCapabilitiesQueryOptions,
} from '@/data/projects/project-capabilities-query'
import { projectOwnershipPoliciesQueryOptions } from '@/data/projects/project-ownership-policies-query'
import { useProjectOwnershipPolicyMutation } from '@/data/projects/project-ownership-policy-mutation'
import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'
import type { OwnershipPolicy } from '@/lib/api/self-platform/ownership-policy'
import { t as $t } from '@/lib/i18n'

const CONFIGURATION_DOMAINS = ['auth', 'storage', 'realtime', 'postgrest'] as const
const OWNERSHIP_MODES = ['observe-only', 'direct-managed', 'gitops-managed'] as const

const driftVariant = (driftState: OwnershipPolicy['driftState']) => {
  if (driftState === 'in-sync') return 'success' as const
  if (driftState === 'ownership-conflict') return 'destructive' as const
  return 'warning' as const
}

export const SelfPlatformOwnershipPolicyPanel = () => {
  const { data: project } = useSelectedProjectQuery()
  const policies = useQuery(projectOwnershipPoliciesQueryOptions({ projectRef: project?.ref }))
  const capabilities = useQuery(projectCapabilitiesQueryOptions({ projectRef: project?.ref }))
  const [serverError, setServerError] = useState<Error>()
  const updatePolicy = useProjectOwnershipPolicyMutation({ onError: setServerError })

  if (!project?.ref) return null
  if (policies.isPending || capabilities.isPending) return <GenericSkeletonLoader />
  if (policies.isError || capabilities.isError) {
    return (
      <AlertError
        error={policies.error ?? capabilities.error}
        subject={$t('Failed to load configuration ownership')}
      />
    )
  }

  const readCapability = findProjectCapability(capabilities.data, 'configuration.ownership.read')
  const updateCapability = findProjectCapability(
    capabilities.data,
    'configuration.ownership.update'
  )
  const reconcileCapability = findProjectCapability(capabilities.data, 'runtime.config.reconcile')
  const policyByDomain = new Map(
    policies.data.policies.map((policy) => [policy.domain, policy] as const)
  )

  if (readCapability?.state !== 'available') {
    return (
      <Alert variant="warning">
        <AlertDescription>
          {readCapability?.blockers[0]?.message ??
            $t('Configuration ownership is unavailable for this project.')}
        </AlertDescription>
      </Alert>
    )
  }

  const handleModeChange = (
    domain: (typeof CONFIGURATION_DOMAINS)[number],
    ownershipMode: (typeof OWNERSHIP_MODES)[number]
  ) => {
    const policy = policyByDomain.get(domain)
    setServerError(undefined)
    updatePolicy.mutate({
      projectRef: project.ref,
      domain,
      ownershipMode,
      expectedRevision: policy?.policyRevision ?? 0,
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{$t('Configuration ownership')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-foreground-light">
          {$t(
            'Choose who owns each runtime configuration domain. Fleet never rewrites user-owned Compose files or takes Kubernetes fields from another manager.'
          )}
        </p>
        {serverError && (
          <AlertError
            error={serverError}
            subject={$t('Failed to update configuration ownership')}
          />
        )}
        {reconcileCapability?.state !== 'available' && (
          <Alert variant="warning">
            <AlertTitle>{$t('Direct reconciliation is unavailable')}</AlertTitle>
            <AlertDescription>
              {reconcileCapability?.blockers[0]?.message ??
                $t('Enroll a compatible Agent before selecting direct-managed mode.')}
            </AlertDescription>
          </Alert>
        )}
        <div className="space-y-3">
          {CONFIGURATION_DOMAINS.map((domain) => {
            const policy = policyByDomain.get(domain)
            return (
              <div
                key={domain}
                className="grid gap-3 rounded-md border p-4 md:grid-cols-[1fr_220px]"
              >
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{domain}</span>
                    <Badge variant={driftVariant(policy?.driftState ?? 'unknown')}>
                      {policy?.driftState ?? $t('unconfigured')}
                    </Badge>
                    {policy && <Badge variant="secondary">{policy.adapter}</Badge>}
                  </div>
                  {policy?.lastObservedAt && (
                    <p className="text-xs text-foreground-muted">
                      {$t('Observed {{observedAt}} at generation {{generation}}', {
                        observedAt: new Date(policy.lastObservedAt).toLocaleString(),
                        generation: policy.lastObservedGeneration ?? '—',
                      })}
                    </p>
                  )}
                  {policy?.blockers.map((blocker) => (
                    <Alert
                      key={`${blocker.code}:${blocker.resource ?? ''}:${blocker.field ?? ''}`}
                      variant="warning"
                    >
                      <AlertTitle>{blocker.code}</AlertTitle>
                      <AlertDescription>
                        {blocker.message}
                        {blocker.owner ? ` ${$t('Current owner')}: ${blocker.owner}.` : ''}
                        {blocker.remediation ? ` ${blocker.remediation}` : ''}
                      </AlertDescription>
                    </Alert>
                  ))}
                </div>
                <Select
                  value={policy?.ownershipMode ?? ''}
                  disabled={
                    updateCapability?.state !== 'available' ||
                    (updatePolicy.isPending && updatePolicy.variables?.domain === domain)
                  }
                  onValueChange={(value) =>
                    handleModeChange(domain, value as (typeof OWNERSHIP_MODES)[number])
                  }
                >
                  <SelectTrigger aria-label={$t('{{domain}} ownership mode', { domain })}>
                    <SelectValue placeholder={$t('Select ownership mode')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="observe-only">{$t('Observe only')}</SelectItem>
                    <SelectItem
                      value="direct-managed"
                      disabled={reconcileCapability?.state !== 'available'}
                    >
                      {$t('Direct managed')}
                    </SelectItem>
                    <SelectItem value="gitops-managed">{$t('GitOps managed')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )
          })}
        </div>
      </CardContent>
      <CardFooter className="border-t text-xs text-foreground-muted">
        {$t(
          'Observe-only and GitOps modes report drift without live mutations. Direct-managed mode changes only Fleet-owned generated files or Kubernetes fields owned by the supabase-fleet field manager.'
        )}
      </CardFooter>
    </Card>
  )
}
