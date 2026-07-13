import { useQuery } from '@tanstack/react-query'
import { Badge, Button, Card, CardContent, CardFooter } from 'ui'

import { useClusterDiscoverMutation } from '@/data/backup-operator/backup-operator-mutations'
import {
  operatorClusterQueryOptions,
  operatorPITRQueryOptions,
} from '@/data/backup-operator/backup-operator-query'

export function SelfPlatformBackupOperatorStatus({ projectRef }: { projectRef?: string }) {
  const clusterQuery = useQuery(operatorClusterQueryOptions({ projectRef }))
  const pitrQuery = useQuery(operatorPITRQueryOptions({ projectRef }))
  const discoverMutation = useClusterDiscoverMutation()
  const discovery = clusterQuery.data?.discovery

  return (
    <Card>
      <CardContent className="grid gap-4 py-4 md:grid-cols-4">
        <div>
          <p className="text-sm font-medium">Provider</p>
          <p className="text-sm text-foreground-light">
            {discovery?.provider ?? 'Not discovered'}
            {discovery?.providerVersion ? ` ${discovery.providerVersion}` : ''}
          </p>
        </div>
        <div>
          <p className="text-sm font-medium">Topology</p>
          <p className="text-sm text-foreground-light">
            {discovery?.topology ?? 'Unknown'}
            {discovery?.primary ? ` · ${discovery.primary}` : ''}
          </p>
        </div>
        <div>
          <p className="text-sm font-medium">Repository</p>
          <p className="break-all text-sm text-foreground-light">
            {discovery?.repositoryType ?? 'Unknown'} ·{' '}
            {discovery?.repositoryLocation ?? discovery?.repositoryId ?? 'Not configured'}
          </p>
        </div>
        <div>
          <p className="text-sm font-medium">Point-in-time recovery</p>
          <Badge
            variant={pitrQuery.data?.enabled && pitrQuery.data.healthy ? 'success' : 'warning'}
          >
            {pitrQuery.data?.enabled
              ? pitrQuery.data.healthy
                ? 'Healthy'
                : 'Blocked'
              : 'Disabled'}
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
          Refresh discovery
        </Button>
      </CardFooter>
    </Card>
  )
}
