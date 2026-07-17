import { IS_PLATFORM, useFlag } from 'common'
import { useParams } from 'common/hooks'
import dayjs from 'dayjs'
import { Check, Copy } from 'lucide-react'
import { useRouter } from 'next/router'
import { useMemo, useState, type MouseEvent } from 'react'
import { Badge, cn, copyToClipboard, TableCell, TableRow } from 'ui'
import { ShimmeringLoader } from 'ui-patterns/ShimmeringLoader'
import { TimestampInfo } from 'ui-patterns/TimestampInfo'

import { formatErrorRate } from './EdgeFunctionsListItem.utils'
import { useProjectApiUrl } from '@/data/config/project-endpoint-query'
import { useEdgeFunctionsLastHourStatsQuery } from '@/data/edge-functions/edge-functions-last-hour-stats-query'
import {
  useEdgeFunctionsQuery,
  type EdgeFunctionsResponse,
} from '@/data/edge-functions/edge-functions-query'
import type { FleetFunctionDeployment } from '@/data/edge-functions/fleet-function-deployments-query'
import { normalizeFunctionIds } from '@/data/edge-functions/keys'
import { t as $t } from '@/lib/i18n'
import { createNavigationHandler } from '@/lib/navigation'

interface EdgeFunctionsListItemProps {
  function: EdgeFunctionsResponse
  deployment?: FleetFunctionDeployment
}

function functionDeploymentStateLabel(state: FleetFunctionDeployment['state']) {
  switch (state) {
    case 'queued':
      return $t('Queued')
    case 'activating':
      return $t('Activating')
    case 'probing':
      return $t('Probing')
    case 'active':
      return $t('Active')
    case 'rolled-back':
      return $t('Rolled back')
    case 'failed':
      return $t('Failed')
    case 'manual-intervention':
      return $t('Manual intervention')
    case 'deleted':
      return $t('Deleted')
  }
}

function functionDeploymentRemediation(remediation: string) {
  switch (remediation) {
    case 'Inspect the immutable artifact and Edge Runtime logs, then deploy a corrected revision.':
      return $t(
        'Inspect the immutable artifact and Edge Runtime logs, then deploy a corrected revision.'
      )
    case 'Restore the function current pointer to the previous immutable revision and verify Edge Runtime before releasing the operation.':
      return $t(
        'Restore the function current pointer to the previous immutable revision and verify Edge Runtime before releasing the operation.'
      )
    case 'Inspect the immutable artifact and Edge Runtime workload events, then deploy a corrected revision.':
      return $t(
        'Inspect the immutable artifact and Edge Runtime workload events, then deploy a corrected revision.'
      )
    case 'Restore the prior artifact pointer and Kubernetes rollout revision, then verify the Edge Runtime workload manually.':
      return $t(
        'Restore the prior artifact pointer and Kubernetes rollout revision, then verify the Edge Runtime workload manually.'
      )
    default:
      return remediation
  }
}

export const EdgeFunctionsListItem = ({
  function: item,
  deployment,
}: EdgeFunctionsListItemProps) => {
  const router = useRouter()
  const { ref } = useParams()
  const [isCopied, setIsCopied] = useState(false)

  const showLastHourStats = useFlag('edgeFunctionsRequestMetrics')

  const { data: endpoint } = useProjectApiUrl({ projectRef: ref })
  const functionUrl = `${endpoint}/functions/v1/${item.slug}`

  const handleNavigation = createNavigationHandler(
    `/project/${ref}/functions/${item.slug}${IS_PLATFORM ? '' : `/code`}`,
    router
  )

  const { data: functions } = useEdgeFunctionsQuery({ projectRef: ref })
  const functionIds = useMemo(() => {
    if (!showLastHourStats || !functions) return []
    return normalizeFunctionIds(functions.map((item) => item.id))
  }, [functions, showLastHourStats])

  // [Joshen] We may be paginating the edge functions query in the future
  // So this will eventually need to be a list of visibleFunctionIds instead + debounced
  const {
    data: lastHourStatsAll,
    isPending: isStatsPending,
    isError: isStatsError,
  } = useEdgeFunctionsLastHourStatsQuery(
    { projectRef: ref, functionIds },
    { enabled: showLastHourStats }
  )
  const lastHourStats = lastHourStatsAll?.[item.id]

  return (
    <TableRow
      key={item.id}
      onClick={handleNavigation}
      onAuxClick={handleNavigation}
      onKeyDown={handleNavigation}
      tabIndex={0}
      className="cursor-pointer inset-focus"
    >
      <TableCell>
        <p className="text-sm text-foreground whitespace-nowrap py-2">{item.name}</p>
      </TableCell>
      <TableCell>
        <div className="text-xs text-foreground-light flex gap-2 items-center truncate">
          <p title={functionUrl} className="font-mono truncate hidden md:inline max-w-120">
            {functionUrl}
          </p>
          <button
            type="button"
            className="text-foreground-lighter hover:text-foreground transition"
            onClick={(event: MouseEvent<HTMLButtonElement>) => {
              function onCopy(value: string) {
                setIsCopied(true)
                copyToClipboard(value)
                setTimeout(() => setIsCopied(false), 3000)
              }
              event.stopPropagation()
              onCopy(functionUrl)
            }}
          >
            {isCopied ? (
              <div className="text-brand">
                <Check size={14} strokeWidth={3} />
              </div>
            ) : (
              <div className="relative">
                <div className="block">
                  <Copy size={14} strokeWidth={1.5} />
                </div>
              </div>
            )}
          </button>
        </div>
      </TableCell>
      <TableCell className="hidden 2xl:table-cell whitespace-nowrap">
        {item.created_at ? (
          <TimestampInfo
            className="text-sm text-foreground-light whitespace-nowrap"
            utcTimestamp={item.created_at}
            label={dayjs(item.created_at).fromNow()}
          />
        ) : (
          <span className="text-sm text-foreground-light">–</span>
        )}
      </TableCell>
      <TableCell className="lg:table-cell">
        {item.updated_at ? (
          <TimestampInfo
            className="text-sm text-foreground-light whitespace-nowrap"
            utcTimestamp={item.updated_at}
            label={dayjs(item.updated_at).fromNow()}
          />
        ) : (
          <span className="text-sm text-foreground-light">–</span>
        )}
      </TableCell>
      {showLastHourStats && (
        <>
          <TableCell className="lg:table-cell whitespace-nowrap">
            {isStatsPending ? (
              <ShimmeringLoader className="w-12" />
            ) : isStatsError ? (
              <p className="text-foreground-lighter" title={$t('Failed to load stats')}>
                -
              </p>
            ) : (
              <p className="text-foreground-light">
                {lastHourStats !== undefined ? lastHourStats.requestsCount.toLocaleString() : '-'}
              </p>
            )}
          </TableCell>
          <TableCell className="lg:table-cell whitespace-nowrap">
            {isStatsPending ? (
              <ShimmeringLoader className="w-12" />
            ) : isStatsError ? (
              <p className="text-foreground-lighter" title={$t('Failed to load stats')}>
                -
              </p>
            ) : lastHourStats !== undefined ? (
              <span
                className={cn(
                  'text-sm',
                  lastHourStats.errorRate >= 1
                    ? 'text-destructive'
                    : lastHourStats.errorRate > 0.1
                      ? 'text-warning'
                      : 'text-foreground-light'
                )}
              >
                {formatErrorRate(lastHourStats.errorRate)}
              </span>
            ) : (
              <p className="text-foreground-lighter">-</p>
            )}
          </TableCell>
        </>
      )}
      <TableCell className="hidden 2xl:table-cell">
        {deployment === undefined ? (
          <p className="text-foreground-light">{item.version}</p>
        ) : (
          <div className="flex flex-col items-start gap-1">
            <Badge
              variant={
                deployment.state === 'active'
                  ? 'success'
                  : deployment.state === 'manual-intervention' || deployment.state === 'failed'
                    ? 'destructive'
                    : deployment.state === 'rolled-back'
                      ? 'warning'
                      : 'default'
              }
            >
              {functionDeploymentStateLabel(deployment.state)}
            </Badge>
            {deployment.remediation && (
              <p className="max-w-64 text-xs text-foreground-light">
                {functionDeploymentRemediation(deployment.remediation)}
              </p>
            )}
            <p className="max-w-64 truncate text-xs text-foreground-lighter">
              {$t('Revision')}: {deployment.desiredRevision}
            </p>
            {deployment.evidence?.probe.message && (
              <p className="max-w-64 text-xs text-foreground-light">
                {$t('Deployment log')}: {deployment.evidence.probe.message}
              </p>
            )}
            {deployment.state === 'rolled-back' && deployment.evidence?.previousDigest && (
              <p className="max-w-64 truncate text-xs text-warning">
                {$t('Rollback restored revision')}: {deployment.evidence.previousDigest}
              </p>
            )}
          </div>
        )}
        <button tabIndex={-1} className="sr-only">
          {$t('Go to function details')}
        </button>
      </TableCell>
    </TableRow>
  )
}
