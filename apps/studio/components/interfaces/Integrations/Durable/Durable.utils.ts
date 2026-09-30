import { literal, safeSql, type SafeSqlFragment } from '@supabase/pg-meta'
import { z } from 'zod'

import { t as $t } from '@/lib/i18n'

const workflowStepFieldsSchema = z.object({
  type: z.enum(['sql', 'sleep', 'signal', 'http']),
  query: z.string(),
  seconds: z.string(),
  signal: z.string(),
  url: z.string(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  body: z.string(),
  headers: z.string(),
  resultName: z.string(),
})

export const workflowStepSchema = workflowStepFieldsSchema.superRefine((step, ctx) => {
  if (!/^$|^[a-zA-Z_][a-zA-Z0-9_]*$/.test(step.resultName))
    ctx.addIssue({
      code: 'custom',
      path: ['resultName'],
      message: $t('Use letters, numbers, and underscores for the result name'),
    })
  const required = (field: 'query' | 'signal' | 'url') => {
    if (!step[field].trim())
      ctx.addIssue({ code: 'custom', path: [field], message: $t('This field is required') })
  }
  if (step.type === 'sql') required('query')
  if (step.type === 'signal') required('signal')
  if (step.type === 'sleep' || step.type === 'signal') {
    const seconds = Number(step.seconds)
    if (
      !/^\d+$/.test(step.seconds) ||
      !Number.isSafeInteger(seconds) ||
      seconds < 1 ||
      seconds > 2147483647
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['seconds'],
        message: $t('Enter a whole number of seconds between 1 and 2147483647'),
      })
    }
  }
  if (step.type === 'http') {
    required('url')
    if (!z.string().url().safeParse(step.url).success || !/^https?:\/\//i.test(step.url)) {
      ctx.addIssue({ code: 'custom', path: ['url'], message: $t('Enter an HTTP or HTTPS URL') })
    }
    try {
      z.record(z.string(), z.string()).parse(JSON.parse(step.headers))
    } catch {
      ctx.addIssue({
        code: 'custom',
        path: ['headers'],
        message: $t('Enter a JSON object with string header values'),
      })
    }
  }
})
export type WorkflowStep = z.infer<typeof workflowStepSchema>

export const workflowFormSchema = z
  .object({
    label: z.string().trim().max(200),
    mode: z.enum(['builder', 'expression']),
    composition: z.enum(['sequential', 'parallel']),
    expression: z.string(),
    steps: z.array(workflowStepFieldsSchema).min(1).max(30),
  })
  .superRefine((values, ctx) => {
    if (values.mode === 'builder') {
      values.steps.forEach((step, index) => {
        const parsed = workflowStepSchema.safeParse(step)
        if (!parsed.success)
          parsed.error.issues.forEach((issue) =>
            ctx.addIssue({ ...issue, path: ['steps', index, ...issue.path] })
          )
      })
    }
    if (values.mode === 'expression' && !values.expression.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: ['expression'],
        message: $t('Enter a workflow expression'),
      })
    }
  })
export type WorkflowFormValues = z.infer<typeof workflowFormSchema>

export const createDefaultStep = (): WorkflowStep => ({
  type: 'sql',
  query: 'SELECT 1 AS result',
  seconds: '30',
  signal: 'approval',
  url: '',
  method: 'GET',
  body: '',
  headers: '{}',
  resultName: '',
})
export const workflowDefaultValues: WorkflowFormValues = {
  label: '',
  mode: 'builder',
  composition: 'sequential',
  expression: '',
  steps: [createDefaultStep()],
}

export function buildStep(input: WorkflowStep): SafeSqlFragment {
  const step = workflowStepSchema.parse(input)
  let expression: SafeSqlFragment
  switch (step.type) {
    case 'sql':
      expression = safeSql`df.sql(${literal(step.query)})`
      break
    case 'sleep':
      expression = safeSql`df.sleep(${literal(Number(step.seconds))}::bigint)`
      break
    case 'signal':
      expression = safeSql`df.wait_for_signal(${literal(step.signal)}, ${literal(Number(step.seconds))}::integer)`
      break
    case 'http':
      expression = safeSql`df.http(${literal(step.url)}, ${literal(step.method)}, ${literal(step.body || null)}, ${literal(step.headers)}::jsonb, 30)`
      break
  }
  return step.resultName ? safeSql`df.as(${expression}, ${literal(step.resultName)})` : expression
}

export function buildWorkflow(
  steps: WorkflowStep[],
  composition: 'sequential' | 'parallel'
): SafeSqlFragment {
  if (!steps.length || steps.length > 30) throw new Error('A workflow needs between 1 and 30 steps')
  const [first, ...remaining] = steps.map(buildStep)
  return remaining.reduce(
    (left, right) =>
      composition === 'parallel'
        ? safeSql`df.join(${left}, ${right})`
        : safeSql`df.seq(${left}, ${right})`,
    first
  )
}

export function buildStartWorkflow(expression: SafeSqlFragment, label: string): SafeSqlFragment {
  return safeSql`SELECT df.start(${expression}, ${literal(label.trim() || null)}) AS value;`
}
export const buildSignalWorkflow = (id: string, name: string, payload: string) =>
  safeSql`SELECT df.signal(${literal(id)}, ${literal(name)}, ${literal(payload)}) AS value;`
export const buildCancelWorkflow = (id: string) =>
  safeSql`SELECT df.cancel(${literal(id)}, 'Cancelled from Studio') AS value;`

export function isWorkflowActive(status: string | null | undefined) {
  return status?.toLowerCase() === 'pending' || status?.toLowerCase() === 'running'
}

export function formatWorkflowValue(value: string | null | undefined) {
  if (!value) return '—'
  try {
    return JSON.stringify(JSON.parse(value), null, 2)
  } catch {
    return value
  }
}

export function getWaitingSignalNames(
  nodes: {
    node_type: string
    inferred_status: string | null
    status: string | null
    query: string | null
  }[]
) {
  return [
    ...new Set(
      nodes.flatMap((node) => {
        if (
          node.node_type !== 'SIGNAL' ||
          (node.inferred_status ?? node.status)?.toLowerCase() !== 'running' ||
          !node.query
        )
          return []
        try {
          const value: unknown = JSON.parse(node.query)
          const parsed = z.object({ signal_name: z.string() }).safeParse(value)
          return parsed.success ? [parsed.data.signal_name] : []
        } catch {
          return []
        }
      })
    ),
  ]
}
