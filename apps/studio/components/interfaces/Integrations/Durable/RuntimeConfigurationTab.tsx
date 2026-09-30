import { useQuery } from '@tanstack/react-query'
import { Badge, Card, CardContent } from 'ui'
import { Admonition } from 'ui-patterns/Admonition'
import { PageSection, PageSectionContent } from 'ui-patterns/PageSection'
import { GenericSkeletonLoader } from 'ui-patterns/ShimmeringLoader'

import { ConstrainedIntegrationTabScaffold } from '../ConstrainedIntegrationTabScaffold'
import { DurableInstalled } from './DurableShared'
import { AlertError } from '@/components/ui/AlertError'
import { durableConfigurationQueryOptions } from '@/data/pg-durable/pg-durable-query'
import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'
import { t as $t } from '@/lib/i18n'

const RuntimeConfigurationContent = () => {
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
  const entries: Array<[string, string | null]> = [
    ['Extension version', data.version],
    ['Database role', data.role],
    ['Worker database', data.database],
    ['Worker role', data.worker_role],
    ['Retention (days)', data.retention_days],
    ['Reconciliation interval (seconds)', data.reconcile_interval],
  ]
  return (
    <div className="max-w-3xl space-y-6">
      <Admonition
        type="default"
        title={$t('Runtime configuration')}
        description={$t(
          'These settings come from Postgres. Preload and worker settings require server configuration and a database restart.'
        )}
      />
      <Card>
        <CardContent className="p-0 divide-y">
          {entries.map(([label, value]) => (
            <div key={label} className="px-5 py-4 flex justify-between gap-4">
              <span className="text-sm text-foreground-light">{$t(label)}</span>
              <code className="text-xs text-right break-all">{value ?? '—'}</code>
            </div>
          ))}
          <div className="px-5 py-4 flex justify-between">
            <span className="text-sm text-foreground-light">{$t('Preloaded')}</span>
            <Badge variant={data.preloaded ? 'success' : 'warning'}>
              {$t(data.preloaded ? 'Yes' : 'No')}
            </Badge>
          </div>
        </CardContent>
      </Card>
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
