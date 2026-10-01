import type { FlowNode } from './Durable.flow'
import { getWorkflowStatusLabel } from './DurableShared'
import { t as $t } from '@/lib/i18n'

export const getMergeCaption = (mode: NonNullable<FlowNode['mergeMode']>) =>
  mode === 'all' ? $t('All branches') : $t('First to finish')

/** Accessible name for a diagram node, matching what the visible card shows. */
export const getNodeAriaLabel = (flow: FlowNode) => {
  switch (flow.kind) {
    case 'start':
      return $t('Start')
    case 'end':
      return $t('End')
    case 'fork':
      return $t('Split into branches')
    case 'merge':
      return flow.mergeMode ? getMergeCaption(flow.mergeMode) : $t('Branches join')
    case 'unknown':
      return `${$t('Unknown step')} ${flow.title}`
    default: {
      const label = $t('{{type}} step {{title}}', { type: flow.stepType, title: flow.title })
      return flow.status ? `${label}, ${getWorkflowStatusLabel(flow.status)}` : label
    }
  }
}
