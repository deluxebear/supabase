import { Badge } from 'ui'

import { parseExecutionGeneration, type DurableTreeNode } from './Durable.tree'
import { formatWorkflowValue } from './Durable.utils'
import { WorkflowStatus } from './DurableShared'
import { t as $t } from '@/lib/i18n'

const getRoleLabel = (step: DurableTreeNode) => {
  switch (step.role) {
    case 'condition':
      return $t('Condition')
    case 'then':
      return $t('Then')
    case 'else':
      return $t('Else')
    case 'body':
      return $t('Body')
    case 'branch':
      return $t('Branch {{number}}', { number: step.branchIndex ?? 1 })
    default:
      return null
  }
}

const StepRow = ({ step, depth }: { step: DurableTreeNode; depth: number }) => {
  const roleLabel = getRoleLabel(step)
  const { node } = step
  const indent = depth > 0 ? 'pl-4 border-l' : ''

  if (!node) {
    return (
      <div className={indent}>
        <div className="border rounded-md bg-surface-100 p-3 flex flex-wrap items-center gap-2">
          {roleLabel && <span className="text-xs text-foreground-light">{roleLabel}</span>}
          <span className="text-xs text-foreground-muted">{$t('Unknown step')}</span>
          <code className="text-xs text-foreground-muted">{step.id}</code>
        </div>
      </div>
    )
  }

  const status = node.inferred_status ?? node.status
  const generation = step.inLoop ? parseExecutionGeneration(node.status_details) : null
  const isFailed = status?.toLowerCase() === 'failed'
  const isSkipped = status?.toLowerCase() === 'skipped'

  return (
    <div className={indent}>
      <details className="border rounded-md bg-surface-100">
        <summary className="cursor-pointer p-3 flex flex-wrap items-center gap-2">
          {roleLabel && <span className="text-xs text-foreground-light">{roleLabel}</span>}
          <Badge>{node.node_type}</Badge>
          <span className="text-xs font-mono">{node.result_name || node.node_id}</span>
          {generation !== null && (
            <span className="text-xs text-foreground-light">
              {$t('Iteration {{number}}', { number: generation })}
            </span>
          )}
          <span className="ml-auto">
            <WorkflowStatus status={status} />
          </span>
        </summary>
        <div className="p-4 pt-0 space-y-3">
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
        </div>
      </details>
      {step.children.length > 0 && (
        <div className="mt-2 space-y-2">
          {step.children.map((child, index) => (
            <StepRow key={`${child.id}-${index}`} step={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  )
}

export const WorkflowStepTree = ({ root }: { root: DurableTreeNode }) => (
  <div className="space-y-2">
    <StepRow step={root} depth={0} />
  </div>
)
