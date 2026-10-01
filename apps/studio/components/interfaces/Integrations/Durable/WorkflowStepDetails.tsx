import { formatWorkflowValue } from './Durable.utils'
import type { DurableNode } from '@/data/pg-durable/pg-durable.types'
import { t as $t } from '@/lib/i18n'

export const WorkflowStepDetails = ({ node }: { node: DurableNode }) => {
  const status = (node.inferred_status ?? node.status)?.toLowerCase()
  const isFailed = status === 'failed'
  const isSkipped = status === 'skipped'
  return (
    <>
      {isSkipped && node.inferred_status_from_ancestor_id && (
        <p className="text-xs text-foreground-light">
          {$t("Skipped because step {{id}} decided this branch won't run.", {
            id: node.inferred_status_from_ancestor_id,
          })}
        </p>
      )}
      {node.query && (
        <>
          <p className="text-xs text-foreground-light">{$t('Step definition')}</p>
          <pre className="text-xs font-mono whitespace-pre-wrap break-all max-h-60 overflow-auto">
            {formatWorkflowValue(node.query)}
          </pre>
        </>
      )}
      {isFailed ? (
        <>
          <p className="text-xs text-foreground-light">{$t('Error')}</p>
          <pre className="text-xs font-mono whitespace-pre-wrap break-all max-h-60 overflow-auto text-destructive">
            {formatWorkflowValue(node.result)}
          </pre>
        </>
      ) : (
        <>
          <p className="text-xs text-foreground-light">{$t('Step result')}</p>
          <pre className="text-xs font-mono whitespace-pre-wrap break-all max-h-60 overflow-auto">
            {formatWorkflowValue(node.result)}
          </pre>
        </>
      )}
      {node.status_details && (
        <details className="border rounded-md">
          <summary className="cursor-pointer p-2 text-xs text-foreground-light">
            {$t('Metadata')}
          </summary>
          <pre className="text-xs font-mono whitespace-pre-wrap break-all p-2 pt-0 max-h-60 overflow-auto">
            {formatWorkflowValue(node.status_details)}
          </pre>
        </details>
      )}
    </>
  )
}
