import { PermissionAction } from '@supabase/shared-types/out/constants'
import { useQuery } from '@tanstack/react-query'
import { Plus, RefreshCw, Workflow } from 'lucide-react'
import { parseAsString, useQueryState } from 'nuqs'
import { useState } from 'react'
import {
  Button,
  Card,
  CardContent,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from 'ui'
import { Admonition } from 'ui-patterns/Admonition'
import { PageSection, PageSectionContent } from 'ui-patterns/PageSection'
import { GenericSkeletonLoader } from 'ui-patterns/ShimmeringLoader'

import { ConstrainedIntegrationTabScaffold } from '../ConstrainedIntegrationTabScaffold'
import { CreateWorkflowSheet } from './CreateWorkflowSheet'
import { DurableInstalled } from './DurableShared'
import { WorkflowDetailSheet } from './WorkflowDetailSheet'
import { WorkflowTable } from './WorkflowTable'
import { AlertError } from '@/components/ui/AlertError'
import { ButtonTooltip } from '@/components/ui/ButtonTooltip'
import {
  durableConfigurationQueryOptions,
  durableInstancesQueryOptions,
  durableMetricsQueryOptions,
} from '@/data/pg-durable/pg-durable-query'
import { durableStatusSchema, type DurableStatus } from '@/data/pg-durable/pg-durable.types'
import { useAsyncCheckPermissions } from '@/hooks/misc/useCheckPermissions'
import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'
import { t as $t } from '@/lib/i18n'
import { onSearchInputEscape } from '@/lib/keyboard'

const WorkflowsContent = () => {
  const { data: project } = useSelectedProjectQuery()
  const variables = { projectRef: project?.ref, connectionString: project?.connectionString }
  const configuration = useQuery(durableConfigurationQueryOptions(variables))
  const { can: canWrite } = useAsyncCheckPermissions(
    PermissionAction.TENANT_SQL_ADMIN_WRITE,
    'functions'
  )
  const [status, setStatus] = useState<DurableStatus>()
  const [label, setLabel] = useState('')
  const [labelInput, setLabelInput] = useState('')
  const [cursors, setCursors] = useState<string[]>([''])
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [instanceId, setInstanceId] = useQueryState('instance', parseAsString)
  const instances = useQuery({
    ...durableInstancesQueryOptions({
      ...variables,
      status,
      label,
      cursor: cursors[cursors.length - 1],
    }),
    enabled: !!project?.ref && configuration.isSuccess,
  })
  const metrics = useQuery({
    ...durableMetricsQueryOptions(variables),
    enabled: !!project?.ref && !!configuration.data?.can_metrics,
  })
  const isRuntimeConfigured =
    !!configuration.data?.preloaded &&
    configuration.data.database === configuration.data.current_database
  const canStart = canWrite && !!configuration.data?.can_start && isRuntimeConfigured
  const handleFilter = () => {
    setLabel(labelInput.trim())
    setCursors([''])
  }

  if (configuration.isPending) return <GenericSkeletonLoader />
  if (configuration.isError)
    return (
      <AlertError
        error={configuration.error}
        subject={$t('Failed to retrieve workflow configuration')}
      />
    )
  const stats = [
    { label: 'Total workflows', value: metrics.data?.total_instances },
    { label: 'Running', value: metrics.data?.running_instances },
    { label: 'Completed', value: metrics.data?.completed_instances },
    { label: 'Failed', value: metrics.data?.failed_instances },
  ]
  return (
    <>
      <div className="space-y-6">
        {!isRuntimeConfigured && (
          <Admonition
            type="warning"
            title={$t('Workflow runtime is not configured')}
            description={$t(
              'Check the preload libraries and target database in Runtime Configuration.'
            )}
          />
        )}
        {configuration.data.can_metrics && (
          <>
            <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
              {stats.map((stat) => (
                <Card key={stat.label}>
                  <CardContent className="p-4">
                    <p className="text-xs text-foreground-light">{$t(stat.label)}</p>
                    <p className="text-2xl tabular-nums mt-2">{stat.value ?? '—'}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
            <p className="text-xs text-foreground-light">
              {$t(
                'Metrics cover all workflows in this database. The list follows your database role permissions.'
              )}
            </p>
            {metrics.isError && (
              <AlertError
                subject={$t('Failed to retrieve workflow metrics')}
                error={metrics.error}
              />
            )}
          </>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Input
            aria-label={$t('Filter by exact label')}
            placeholder={$t('Filter by exact label')}
            value={labelInput}
            className="w-56"
            onChange={(e) => setLabelInput(e.target.value)}
            onKeyDown={(e) => {
              onSearchInputEscape(labelInput, () => {
                setLabelInput('')
                setLabel('')
                setCursors([''])
              })(e)
              if (e.key === 'Enter') handleFilter()
            }}
          />
          <Button onClick={handleFilter}>{$t('Apply filter')}</Button>
          <Select
            value={status ?? 'all'}
            onValueChange={(value) => {
              setStatus(value === 'all' ? undefined : durableStatusSchema.parse(value))
              setCursors([''])
            }}
          >
            <SelectTrigger className="w-40" aria-label={$t('Filter by status')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{$t('All statuses')}</SelectItem>
              {durableStatusSchema.options.map((value) => (
                <SelectItem key={value} value={value}>
                  {$t(value.charAt(0).toUpperCase() + value.slice(1))}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="flex gap-2 sm:ml-auto">
            <Button
              icon={<RefreshCw size={14} />}
              loading={instances.isFetching}
              onClick={() => {
                void instances.refetch()
                if (configuration.data.can_metrics) void metrics.refetch()
              }}
            >
              {$t('Refresh')}
            </Button>
            <ButtonTooltip
              variant="primary"
              icon={<Plus size={14} />}
              disabled={!canStart}
              tooltip={{
                content: {
                  text: !canStart
                    ? $t(
                        'Workflow creation requires database write permission, pg_durable access, and a configured runtime.'
                      )
                    : undefined,
                },
              }}
              onClick={() => setIsCreateOpen(true)}
            >
              {$t('Create workflow')}
            </ButtonTooltip>
          </div>
        </div>
        {instances.isPending && <GenericSkeletonLoader />}
        {instances.isError && (
          <AlertError error={instances.error} subject={$t('Failed to retrieve workflows')} />
        )}
        {instances.isSuccess && instances.data.length === 0 && (
          <div className="border rounded-md px-6 py-16 text-center flex flex-col items-center gap-3">
            <Workflow className="text-foreground-muted" size={32} />
            <h3>{$t(label || status ? 'No workflows match these filters' : 'No workflows yet')}</h3>
            <p className="text-sm text-foreground-light">
              {$t(
                'Create a workflow to run durable SQL steps, timers, signals, and HTTP requests.'
              )}
            </p>
          </div>
        )}
        {instances.isSuccess && instances.data.length > 0 && (
          <WorkflowTable
            rows={instances.data}
            onSelect={(id) => {
              void setInstanceId(id)
            }}
          />
        )}
        <div className="flex justify-between items-center text-xs text-foreground-light">
          <p>{$t('Updates every 5 seconds')}</p>
          <div className="flex items-center gap-2">
            <Button
              disabled={cursors.length <= 1 || instances.isFetching}
              onClick={() => setCursors((current) => current.slice(0, -1))}
            >
              {$t('Previous')}
            </Button>
            <span>{$t('Page {{number}}', { number: cursors.length })}</span>
            <Button
              disabled={!instances.data?.[0]?.next_cursor || instances.isFetching}
              onClick={() => {
                const next = instances.data?.[0]?.next_cursor
                if (next) setCursors((current) => [...current, next])
              }}
            >
              {$t('Next')}
            </Button>
          </div>
        </div>
      </div>
      {isCreateOpen && (
        <CreateWorkflowSheet
          configuration={configuration.data}
          onClose={() => setIsCreateOpen(false)}
          onCreated={(id) => {
            setCursors([''])
            setStatus(undefined)
            setLabel('')
            setLabelInput('')
            void setInstanceId(id)
          }}
        />
      )}
      {instanceId && (
        <WorkflowDetailSheet
          key={instanceId}
          instanceId={instanceId}
          configuration={configuration.data}
          canWrite={canWrite}
          onClose={() => {
            void setInstanceId(null)
          }}
        />
      )}
    </>
  )
}

export const WorkflowsTab = () => (
  <ConstrainedIntegrationTabScaffold>
    <PageSection>
      <PageSectionContent>
        <DurableInstalled>
          <WorkflowsContent />
        </DurableInstalled>
      </PageSectionContent>
    </PageSection>
  </ConstrainedIntegrationTabScaffold>
)
