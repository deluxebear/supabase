import { PermissionAction } from '@supabase/shared-types/out/constants'
import type { PropsWithChildren } from 'react'
import { Badge } from 'ui'
import { Admonition } from 'ui-patterns/Admonition'
import { GenericSkeletonLoader } from 'ui-patterns/ShimmeringLoader'

import { RequiredExtensionsSection } from '../Integration/RequiredExtensionsSection'
import { AlertError } from '@/components/ui/AlertError'
import { useDatabaseExtensionsQuery } from '@/data/database-extensions/database-extensions-query'
import { useAsyncCheckPermissions } from '@/hooks/misc/useCheckPermissions'
import { useSelectedProjectQuery } from '@/hooks/misc/useSelectedProject'
import { t as $t } from '@/lib/i18n'

const STATUS_LABELS: Record<string, string> = {
  pending: 'Pending',
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
}
export const WorkflowStatus = ({ status }: { status?: string | null }) => {
  const normalized = status?.toLowerCase() ?? ''
  const variant =
    normalized === 'failed'
      ? 'destructive'
      : normalized === 'completed'
        ? 'success'
        : normalized === 'running'
          ? 'warning'
          : 'default'
  return <Badge variant={variant}>{$t(STATUS_LABELS[normalized] ?? status ?? 'Unknown')}</Badge>
}

export const DurableInstalled = ({ children }: PropsWithChildren) => {
  const { data: project } = useSelectedProjectQuery()
  const { can: canRead, isLoading: isPermissionLoading } = useAsyncCheckPermissions(
    PermissionAction.TENANT_SQL_ADMIN_READ,
    'functions'
  )
  const extensions = useDatabaseExtensionsQuery({
    projectRef: project?.ref,
    connectionString: project?.connectionString,
  })
  if (extensions.isPending || isPermissionLoading) return <GenericSkeletonLoader />
  if (extensions.isError)
    return <AlertError error={extensions.error} subject={$t('Failed to retrieve extensions')} />
  if (!extensions.data.some((ext) => ext.name === 'pg_durable' && !!ext.installed_version))
    return <RequiredExtensionsSection hideSeparator />
  if (!canRead) return <Admonition type="default" title={$t('Database read permission required')} />
  return <>{children}</>
}
