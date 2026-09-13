import { cn, Skeleton } from 'ui'

import type { SecretRequest } from './McpSecrets.types'
import { t as $t } from '@/lib/i18n'

const DETAIL_ROW_COUNT = 3

const DetailRow = ({
  label,
  value,
  isMono = false,
}: {
  label: string
  value: string
  isMono?: boolean
}) => (
  <div className="flex items-center justify-between gap-4 py-2.5 text-xs">
    <span className="shrink-0 text-foreground-light">{label}</span>
    <span className={cn('min-w-0 truncate text-right text-foreground', isMono && 'font-mono')}>
      {value}
    </span>
  </div>
)

export const McpSecretsDetails = ({ request }: { request: SecretRequest }) => (
  <div className="divide-y rounded-md border bg-surface-75 px-4">
    <DetailRow label={$t('Tool')} value={request.tool} isMono />
    <DetailRow label={$t('Project')} value={request.project} />
    <DetailRow label={$t('Signed in as')} value={request.account} />
  </div>
)

export const McpSecretsDetailsSkeleton = () => (
  <div className="divide-y rounded-md border bg-surface-75 px-4">
    {Array.from({ length: DETAIL_ROW_COUNT }).map((_, index) => (
      <div key={index} className="flex items-center justify-between gap-4 py-2.5 text-xs">
        <Skeleton className="h-4 w-16" />
        <Skeleton className="h-4 w-24" />
      </div>
    ))}
  </div>
)
