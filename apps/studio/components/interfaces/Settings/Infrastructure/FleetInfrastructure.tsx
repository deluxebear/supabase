import { useParams } from 'common'
import { CheckCircle2, CircleSlash2, RefreshCw, XCircle } from 'lucide-react'
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, cn } from 'ui'
import { Admonition } from 'ui-patterns/admonition'
import { GenericSkeletonLoader } from 'ui-patterns/ShimmeringLoader'

import { useRuntimeInventoryQuery } from '@/data/infrastructure/runtime-inventory-query'
import { t as $t } from '@/lib/i18n'

const gibibyte = 1024 ** 3

function bytes(value: number) {
  if (value >= gibibyte) return `${(value / gibibyte).toFixed(2)} GiB`
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`
  return `${value} B`
}

function StatusIcon({ state }: { state: string }) {
  if (state === 'passed' || state === 'healthy' || state === 'running')
    return <CheckCircle2 className="size-4 text-brand" />
  if (state === 'failed' || state === 'unhealthy' || state === 'exited')
    return <XCircle className="size-4 text-destructive" />
  return <CircleSlash2 className="size-4 text-warning" />
}

const InventoryRow = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-center justify-between gap-4 border-b py-2.5 last:border-b-0">
    <span className="text-sm text-foreground-light">{label}</span>
    <span className="text-sm font-medium text-right">{value}</span>
  </div>
)

export const FleetInfrastructure = () => {
  const { ref } = useParams()
  const { data, error, isPending, isFetching, refetch } = useRuntimeInventoryQuery(ref)

  if (isPending) return <GenericSkeletonLoader />
  if (error || !data)
    return (
      <Admonition
        type="destructive"
        title={$t('Unable to load runtime inventory')}
        description={
          error instanceof Error
            ? error.message
            : $t('The Fleet Agent runtime inventory is unavailable.')
        }
      >
        <Button type="button" onClick={() => refetch()}>
          {$t('Retry')}
        </Button>
      </Admonition>
    )

  const diskPercent = Math.min(
    100,
    (data.disk.filesystemUsedBytes / data.disk.filesystemSizeBytes) * 100
  )
  const unhealthyContainers = data.containers.filter(
    (item) => item.state !== 'running' || item.health === 'unhealthy'
  )

  return (
    <div className="space-y-6 pb-12">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-medium">{$t('Capacity and runtime inventory')}</h2>
          <p className="text-sm text-foreground-light">
            {$t('Observed by the project Agent from the Compose host and PostgreSQL runtime.')}
          </p>
        </div>
        <Button type="button" disabled={isFetching} loading={isFetching} onClick={() => refetch()}>
          <RefreshCw className="mr-2 size-4" />
          {$t('Refresh')}
        </Button>
      </div>

      {unhealthyContainers.length > 0 && (
        <Admonition
          type="warning"
          title={$t('Some runtime services need attention')}
          description={unhealthyContainers.map((item) => item.service).join(', ')}
        />
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{$t('Database volume')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mb-4">
              <div className="mb-1 flex justify-between text-sm">
                <span>{bytes(data.disk.filesystemUsedBytes)} {$t('used')}</span>
                <span>{bytes(data.disk.filesystemSizeBytes)}</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-surface-200">
                <div
                  className={cn('h-full bg-brand transition-all', diskPercent >= 90 && 'bg-warning')}
                  style={{ width: `${diskPercent}%` }}
                />
              </div>
            </div>
            <InventoryRow label={$t('Database')} value={bytes(data.disk.databaseBytes)} />
            <InventoryRow label="WAL" value={bytes(data.disk.walBytes)} />
            <InventoryRow label={$t('System and other')} value={bytes(data.disk.systemBytes)} />
            <InventoryRow
              label={$t('Filesystem available')}
              value={bytes(data.disk.filesystemAvailableBytes)}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{$t('Compute')}</CardTitle>
          </CardHeader>
          <CardContent>
            <InventoryRow
              label={$t('CPU capacity')}
              value={`${data.compute.cpuCores} ${$t('shared cores')}`}
            />
            <InventoryRow label={$t('Memory capacity')} value={bytes(data.compute.memoryBytes)} />
            <InventoryRow label={$t('Allocation source')} value={data.compute.source} />
            <InventoryRow label={$t('Containers')} value={String(data.containers.length)} />
            <InventoryRow label={$t('Volumes')} value={String(data.volumes.length)} />
            <InventoryRow
              label={$t('Observed')}
              value={new Date(data.observedAt).toLocaleString()}
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{$t('Service versions')}</CardTitle>
        </CardHeader>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="border-b bg-surface-100 text-left text-foreground-light">
              <tr>
                <th className="px-6 py-3 font-normal">{$t('Service')}</th>
                <th className="px-6 py-3 font-normal">{$t('Version')}</th>
                <th className="px-6 py-3 font-normal">{$t('Image')}</th>
                <th className="px-6 py-3 font-normal">{$t('Status')}</th>
              </tr>
            </thead>
            <tbody>
              {data.versions.map((item) => (
                <tr key={item.service} className="border-b last:border-b-0">
                  <td className="px-6 py-3 font-medium">{item.service}</td>
                  <td className="px-6 py-3 font-mono text-xs">{item.version}</td>
                  <td className="max-w-md truncate px-6 py-3 font-mono text-xs" title={item.image}>
                    {item.image}
                  </td>
                  <td className="px-6 py-3">
                    <span className="flex items-center gap-2">
                      <StatusIcon state={item.health === 'not-configured' ? item.state : item.health} />
                      {item.health === 'not-configured' ? item.state : item.health}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-4">
            <CardTitle>{$t('PostgreSQL upgrade readiness')}</CardTitle>
            <Badge variant={data.upgrade.eligible ? 'success' : 'warning'}>
              {data.upgrade.eligible ? $t('Eligible') : $t('Blocked')}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-4 md:grid-cols-3">
            <InventoryRow
              label={$t('Current version')}
              value={data.upgrade.currentPostgresVersion}
            />
            <InventoryRow
              label={$t('Latest approved')}
              value={data.upgrade.latestSupportedVersion}
            />
            <InventoryRow label={$t('Progress')} value={data.upgrade.progress} />
          </div>
          <div>
            <h4 className="mb-2 text-sm font-medium">{$t('Preflight')}</h4>
            <div className="space-y-2">
              {data.upgrade.checks.map((check) => (
                <div key={check.code} className="flex items-start gap-2 text-sm">
                  <StatusIcon state={check.state} />
                  <div>
                    <p className="font-medium">{check.code}</p>
                    <p className="text-foreground-light">{check.message}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
          {data.upgrade.blockers.map((blocker) => (
            <Admonition
              key={blocker.code}
              type="warning"
              title={blocker.message}
              description={blocker.remediation}
            />
          ))}
          <div className="grid gap-5 lg:grid-cols-3">
            {[
              [$t('Upgrade plan'), data.upgrade.plan],
              [$t('Rollback'), data.upgrade.rollback],
              [$t('Failure recovery'), data.upgrade.recovery],
            ].map(([title, items]) => (
              <div key={String(title)}>
                <h4 className="mb-2 text-sm font-medium">{title}</h4>
                <ol className="list-decimal space-y-1 pl-5 text-sm text-foreground-light">
                  {(items as string[]).map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{$t('Compose containers and volumes')}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-6 lg:grid-cols-2">
          <div>
            <h4 className="mb-2 text-sm font-medium">{$t('Containers')}</h4>
            {data.containers.map((item) => (
              <InventoryRow
                key={item.name}
                label={item.service}
                value={`${item.state} · ${item.health}`}
              />
            ))}
          </div>
          <div>
            <h4 className="mb-2 text-sm font-medium">{$t('Volumes')}</h4>
            {data.volumes.map((item) => (
              <InventoryRow key={item.name} label={item.name} value={bytes(item.usedBytes)} />
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
