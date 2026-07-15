import { useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from 'ui'

import { AlertError } from '@/components/ui/AlertError'
import type { EnrollmentTokenResponse } from '@/data/management-trust/types'
import { managementTargetsQueryOptions } from '@/data/organizations/management-targets-query'
import {
  findProjectCapability,
  projectCapabilitiesQueryOptions,
} from '@/data/projects/project-capabilities-query'
import {
  useProjectEnrollmentTokenMutation,
  useProjectManagementBindMutation,
  useProjectManagementRevokeMutation,
  useProjectManagementSyncMutation,
} from '@/data/projects/project-management-binding-mutations'
import { projectManagementBindingQueryOptions } from '@/data/projects/project-management-binding-query'
import { useSelectedOrganizationQuery } from '@/hooks/misc/useSelectedOrganization'
import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'
import { t as $t } from '@/lib/i18n'

export const SelfPlatformManagementTrustPanel = () => {
  const { data: project } = useSelectedProjectQuery()
  const { data: organization } = useSelectedOrganizationQuery()
  const targets = useQuery(managementTargetsQueryOptions({ slug: organization?.slug }))
  const bindingQuery = useQuery(projectManagementBindingQueryOptions({ projectRef: project?.ref }))
  const capabilities = useQuery(projectCapabilitiesQueryOptions({ projectRef: project?.ref }))
  const [targetId, setTargetId] = useState('')
  const [executionTarget, setExecutionTarget] = useState('')
  const [deploymentKind, setDeploymentKind] = useState<
    'compose' | 'kubernetes' | 'systemd' | 'bare-metal'
  >('compose')
  const [prefixes, setPrefixes] = useState('backup.,runtime.')
  const [token, setToken] = useState<EnrollmentTokenResponse>()
  const [serverError, setServerError] = useState<Error>()
  const binding = bindingQuery.data?.binding
  const bindCapability = findProjectCapability(capabilities.data, 'management.target.bind')
  const enrollmentCapability = findProjectCapability(
    capabilities.data,
    'management.enrollment.issue'
  )

  const bind = useProjectManagementBindMutation({ onError: setServerError })
  const issue = useProjectEnrollmentTokenMutation({ onSuccess: setToken, onError: setServerError })
  const sync = useProjectManagementSyncMutation({ onError: setServerError })
  const revoke = useProjectManagementRevokeMutation({
    onSuccess: () => setToken(undefined),
    onError: setServerError,
  })
  const activeTargets = useMemo(
    () => targets.data?.targets.filter((item) => item.state === 'active') ?? [],
    [targets.data]
  )
  const blockers = binding ? enrollmentCapability?.blockers : bindCapability?.blockers

  if (!project?.ref) return null

  const submitBinding = () => {
    if (!targetId || !executionTarget.trim()) return
    setServerError(undefined)
    bind.mutate({
      projectRef: project.ref,
      payload: {
        managementTargetId: targetId,
        executionTarget: executionTarget.trim(),
        deploymentKind,
        allowedCapabilityPrefixes: prefixes
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean),
      },
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{$t('Management trust')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-foreground-light">
          {$t(
            'Bind this project to one trusted management target. Agent credentials are issued by CSR and are never exposed in Studio.'
          )}
        </p>
        {(targets.isError || bindingQuery.isError || capabilities.isError) && (
          <AlertError
            error={targets.error ?? bindingQuery.error ?? capabilities.error}
            subject={$t('Failed to load management trust')}
          />
        )}
        {serverError && (
          <AlertError error={serverError} subject={$t('Management trust operation failed')} />
        )}
        {blockers?.map((blocker) => (
          <Alert key={blocker.code} variant="warning">
            <AlertTitle>{blocker.code}</AlertTitle>
            <AlertDescription>
              {blocker.message}
              {blocker.remediation ? ` ${blocker.remediation}` : ''}
            </AlertDescription>
          </Alert>
        ))}

        {!binding ? (
          <div className="grid gap-3 md:grid-cols-2">
            <Select value={targetId} onValueChange={setTargetId}>
              <SelectTrigger>
                <SelectValue placeholder={$t('Select management target')} />
              </SelectTrigger>
              <SelectContent>
                {activeTargets.map((target) => (
                  <SelectItem key={target.id} value={target.id}>
                    {target.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={executionTarget}
              onChange={(event) => setExecutionTarget(event.target.value)}
              placeholder={$t('Execution target, for example compose://prod')}
            />
            <Select
              value={deploymentKind}
              onValueChange={(value) => setDeploymentKind(value as typeof deploymentKind)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {['compose', 'kubernetes', 'systemd', 'bare-metal'].map((value) => (
                  <SelectItem key={value} value={value}>
                    {value}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              value={prefixes}
              onChange={(event) => setPrefixes(event.target.value)}
              placeholder={$t('Allowed capability prefixes, comma separated')}
            />
            <div className="md:col-span-2">
              <Button
                disabled={
                  bindCapability?.state !== 'available' || !targetId || !executionTarget.trim()
                }
                loading={bind.isPending}
                onClick={submitBinding}
              >
                {$t('Bind management target')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded-md border p-4 space-y-1">
              <div className="flex items-center gap-2">
                <span className="font-medium">{binding.managementTargetName}</span>
                <Badge>{binding.state}</Badge>
              </div>
              <p className="text-sm text-foreground-light">
                {binding.executionTarget} · {binding.deploymentKind}
              </p>
              <p className="text-xs text-foreground-muted">
                {$t('Agent')}: {binding.agentId ?? $t('Not enrolled')} ·{' '}
                {$t('Certificate revision')}: {binding.activeCertificateRevision ?? '—'}
              </p>
              <p className="text-xs text-foreground-muted">
                {$t('Last seen')}:{' '}
                {binding.lastSeenAt ? new Date(binding.lastSeenAt).toLocaleString() : '—'}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button
                loading={issue.isPending}
                disabled={enrollmentCapability?.state !== 'available'}
                onClick={() => issue.mutate({ projectRef: project.ref })}
              >
                {$t('Issue single-use token')}
              </Button>
              <Button
                variant="default"
                loading={sync.isPending}
                disabled={enrollmentCapability?.state !== 'available'}
                onClick={() => sync.mutate({ projectRef: project.ref })}
              >
                {$t('Refresh Agent status')}
              </Button>
              <Button
                variant="danger"
                loading={revoke.isPending}
                disabled={bindCapability?.state !== 'available'}
                onClick={() => revoke.mutate({ projectRef: project.ref })}
              >
                {$t('Revoke Agent trust')}
              </Button>
            </div>
          </div>
        )}

        {token && binding && (
          <Alert variant="warning">
            <AlertTitle>{$t('Copy this token now')}</AlertTitle>
            <AlertDescription className="space-y-2">
              <p>
                {$t('It expires at {{expiresAt}} and cannot be displayed again.', {
                  expiresAt: new Date(token.expiresAt).toLocaleString(),
                })}
              </p>
              <code className="block break-all rounded bg-surface-100 p-2 text-xs">
                {token.token}
              </code>
              <Button
                size="tiny"
                variant="default"
                onClick={() => navigator.clipboard.writeText(token.token)}
              >
                {$t('Copy token')}
              </Button>
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
      <CardFooter className="border-t text-xs text-foreground-muted">
        {$t(
          'The enrollment token is hash-only at Fleet Control and is bound to organization, project, target, binding, execution target, deployment kind, and capability prefixes.'
        )}
      </CardFooter>
    </Card>
  )
}
