import { useQuery } from '@tanstack/react-query'
import { Badge, Card, CardContent, Tooltip, TooltipContent, TooltipTrigger } from 'ui'
import { Admonition } from 'ui-patterns/Admonition'
import { CodeBlock } from 'ui-patterns/CodeBlock'
import { PageSection, PageSectionContent } from 'ui-patterns/PageSection'
import { GenericSkeletonLoader } from 'ui-patterns/ShimmeringLoader'

import { ConstrainedIntegrationTabScaffold } from '../ConstrainedIntegrationTabScaffold'
import { DurableInstalled } from './DurableShared'
import { AlertError } from '@/components/ui/AlertError'
import { durableConfigurationQueryOptions } from '@/data/pg-durable/pg-durable-query'
import type { DurableConfiguration } from '@/data/pg-durable/pg-durable.types'
import { compareDurableVersions, getDurableCapabilities } from '@/data/pg-durable/pg-durable.utils'
import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'
import { t as $t } from '@/lib/i18n'

type ConfigurationRowValue = { label: string; value: string | null }
type ConfigurationGroup = { title: string; rows: ConfigurationRowValue[] }

const getGroups = (data: DurableConfiguration): ConfigurationGroup[] => [
  {
    title: 'Worker',
    rows: [
      { label: 'Extension version', value: data.version },
      { label: 'Installed version', value: data.installed_version },
      { label: 'Available version', value: data.default_version },
      { label: 'Worker database', value: data.database },
      { label: 'Worker role', value: data.worker_role },
      { label: 'Database role', value: data.role },
      { label: 'Host', value: data.host },
      { label: 'Reconciliation interval (seconds)', value: data.reconcile_interval },
    ],
  },
  {
    title: 'Starts and listing',
    rows: [
      { label: 'Superuser workflows', value: data.enable_superuser_instances },
      { label: 'Max independent starts', value: data.max_new_transaction_starts },
      { label: 'Independent start timeout (seconds)', value: data.new_transaction_start_timeout },
      { label: 'Max list page size', value: data.list_instances_max_limit },
    ],
  },
  {
    title: 'Connections',
    rows: [
      { label: 'Max user connections', value: data.max_user_connections },
      { label: 'Max management connections', value: data.max_management_connections },
      { label: 'Max engine connections', value: data.max_duroxide_connections },
      { label: 'Execution acquire timeout', value: data.execution_acquire_timeout },
    ],
  },
  {
    title: 'Retention and logging',
    rows: [
      { label: 'Retention (days)', value: data.retention_days },
      { label: 'Log workflow SQL', value: data.log_workflow_sql },
    ],
  },
]

const ConfigurationRow = ({ label, value }: ConfigurationRowValue) => (
  <div className="px-5 py-4 flex justify-between gap-4">
    <span className="text-sm text-foreground-light">{$t(label)}</span>
    {value === null ? (
      <Tooltip>
        <TooltipTrigger asChild>
          <code className="text-xs text-right text-foreground-lighter">—</code>
        </TooltipTrigger>
        <TooltipContent side="left">{$t('Not available in this version')}</TooltipContent>
      </Tooltip>
    ) : (
      <code className="text-xs text-right break-all">{value}</code>
    )}
  </div>
)

const getUnavailableFeatures = (installedVersion: string | null) => {
  if (installedVersion === null) return []
  const capabilities = getDurableCapabilities(installedVersion)
  return [
    !capabilities.multipart && $t('Multipart HTTP requests (requires 0.2.5)'),
    !capabilities.transactionMode && $t('Independent-transaction starts (requires 0.2.5)'),
    !capabilities.loopContinueOnFailure &&
      $t('Continue after step failures in loops (requires 0.2.8)'),
  ].filter((feature): feature is string => !!feature)
}

export const RuntimeConfigurationContent = () => {
  const { data: project } = useSelectedProjectQuery()
  const configuration = useQuery(
    durableConfigurationQueryOptions({
      projectRef: project?.ref,
      connectionString: project?.connectionString,
    })
  )
  if (configuration.isPending) return <GenericSkeletonLoader />
  if (configuration.isError)
    return (
      <AlertError
        error={configuration.error}
        subject={$t('Failed to retrieve workflow configuration')}
      />
    )
  const data = configuration.data
  const { installed_version: installed, default_version: available } = data
  const versionComparison =
    installed && available ? compareDurableVersions(installed, available) : null
  const isUpdateAvailable = versionComparison !== null && versionComparison < 0
  const unavailableFeatures = getUnavailableFeatures(installed)
  return (
    <div className="max-w-3xl space-y-6">
      <Admonition
        type="default"
        title={$t('Runtime configuration')}
        description={$t(
          'These settings come from Postgres. Preload and worker settings require server configuration and a database restart.'
        )}
      />
      {data.log_workflow_sql === 'on' && (
        <Admonition
          type="warning"
          title={$t('Workflow SQL is written to Postgres logs')}
          description={$t(
            'The background worker logs fully substituted workflow SQL, including variable values. Set pg_durable.log_workflow_sql to off and restart Postgres to stop this.'
          )}
        />
      )}
      {isUpdateAvailable && (
        <Admonition type="default" title={$t('An extension update is available')}>
          <p>
            {$t(
              'Let running loops and waits finish before updating. In-flight workflows may fail to resume after an update.'
            )}
          </p>
          <CodeBlock
            hideLineNumbers
            language="sql"
            value="ALTER EXTENSION pg_durable UPDATE;"
            className="py-3 px-4 text-xs"
            wrapperClassName="max-w-full mt-2"
          />
        </Admonition>
      )}
      {unavailableFeatures.length > 0 && (
        <Admonition type="note" title={$t('Some workflow features are unavailable')}>
          <ul>
            {unavailableFeatures.map((feature) => (
              <li key={feature}>{feature}</li>
            ))}
          </ul>
        </Admonition>
      )}
      {getGroups(data).map((group) => (
        <div key={group.title} className="space-y-2">
          <h4 className="text-sm text-foreground">{$t(group.title)}</h4>
          <Card>
            <CardContent className="p-0 divide-y">
              {group.rows.map((row) => (
                <ConfigurationRow key={row.label} {...row} />
              ))}
              {group.title === 'Worker' && (
                <div className="px-5 py-4 flex justify-between">
                  <span className="text-sm text-foreground-light">{$t('Preloaded')}</span>
                  <Badge variant={data.preloaded ? 'success' : 'warning'}>
                    {$t(data.preloaded ? 'Yes' : 'No')}
                  </Badge>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      ))}
      {!data.can_start && (
        <Admonition
          type="warning"
          title={$t('This database role cannot start workflows')}
          description={$t(
            'Use a role with pg_durable usage privileges. Superuser workflow execution is disabled by default.'
          )}
        />
      )}
      <div className="text-sm text-foreground-light space-y-3">
        <h4 className="text-foreground">{$t('Retention and access')}</h4>
        <p>
          {$t(
            'pg_durable cleans up terminal workflow history according to its retention settings. Pending and running workflows are retained.'
          )}
        </p>
        <p>
          {$t(
            'Workflow visibility follows pg_durable row-level security. The current database role determines which instances you can see and manage.'
          )}
        </p>
      </div>
    </div>
  )
}
export const RuntimeConfigurationTab = () => (
  <ConstrainedIntegrationTabScaffold>
    <PageSection>
      <PageSectionContent>
        <DurableInstalled>
          <RuntimeConfigurationContent />
        </DurableInstalled>
      </PageSectionContent>
    </PageSection>
  </ConstrainedIntegrationTabScaffold>
)
