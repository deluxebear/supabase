import { useQuery } from '@tanstack/react-query'
import { Badge, Button, Card, CardContent, CardFooter } from 'ui'

import { useClusterDiscoverMutation } from '@/data/backup-operator/backup-operator-mutations'
import {
  operatorClusterQueryOptions,
  operatorPITRQueryOptions,
} from '@/data/backup-operator/backup-operator-query'
import { t as $t } from '@/lib/i18n'

export function SelfPlatformBackupOperatorStatus({ projectRef }: { projectRef?: string }) {
  const clusterQuery = useQuery(operatorClusterQueryOptions({ projectRef }))
  const pitrQuery = useQuery(operatorPITRQueryOptions({ projectRef }))
  const discoverMutation = useClusterDiscoverMutation()
  const discovery = clusterQuery.data?.discovery

  return (
    <Card>
      <CardContent className="grid gap-4 py-4 md:grid-cols-4">
        <div>
          <p className="text-sm font-medium">{$t('Provider')}</p>
          <p className="text-sm text-foreground-light">
            {discovery?.provider ?? $t('Not discovered')}
            {discovery?.providerVersion ? ` ${discovery.providerVersion}` : ''}
          </p>
        </div>
        <div>
          <p className="text-sm font-medium">{$t('Topology')}</p>
          <p className="text-sm text-foreground-light">
            {discovery?.topology ?? $t('Unknown')}
            {discovery?.primary ? ` · ${discovery.primary}` : ''}
          </p>
        </div>
        <div>
          <p className="text-sm font-medium">{$t('Repository')}</p>
          <p className="break-all text-sm text-foreground-light">
            {discovery?.repositoryType ?? $t('Unknown')} ·{' '}
            {discovery?.repositoryLocation ?? discovery?.repositoryId ?? $t('Not configured')}
          </p>
        </div>
        <div>
          <p className="text-sm font-medium">{$t('Point-in-time recovery')}</p>
          <Badge
            variant={pitrQuery.data?.enabled && pitrQuery.data.healthy ? 'success' : 'warning'}
          >
            {pitrQuery.data?.enabled
              ? pitrQuery.data.healthy
                ? $t('Healthy')
                : $t('Blocked')
              : $t('Disabled')}
          </Badge>
        </div>
      </CardContent>
      <CardFooter className="justify-end">
        <Button
          type="button"
          loading={discoverMutation.isPending}
          disabled={!projectRef}
          onClick={() => projectRef && discoverMutation.mutate({ projectRef })}
        >
          {$t('Refresh discovery')}
        </Button>
      </CardFooter>
    </Card>
  )
}
