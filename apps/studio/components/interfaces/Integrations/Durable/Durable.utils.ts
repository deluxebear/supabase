import { literal, safeSql, type SafeSqlFragment } from '@supabase/pg-meta'
import { z } from 'zod'

import type { DurableCapabilities } from '@/data/pg-durable/pg-durable.utils'
import { t as $t } from '@/lib/i18n'

export const LEAF_STEP_TYPES = [
  'sql',
  'sleep',
  'signal',
  'http',
  'multipart',
  'schedule',
  'break',
] as const
export const CONTAINER_STEP_TYPES = ['loop', 'if', 'if_rows', 'race', 'parallel'] as const

const leafFields = {
  query: z.string(),
  seconds: z.string(),
  noTimeout: z.boolean(),
  signal: z.string(),
  url: z.string(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  requestBody: z.string(),
  headers: z.string(),
  timeoutSeconds: z.string(),
  parts: z.string(),
  cron: z.string(),
  breakValue: z.string(),
  resultName: z.string(),
}
export const leafStepFieldsSchema = z.object({ type: z.enum(LEAF_STEP_TYPES), ...leafFields })
export const workflowStepFieldsSchema = z.object({
  type: z.enum([...LEAF_STEP_TYPES, ...CONTAINER_STEP_TYPES]),
  ...leafFields,
  condition: z.string(),
  rowsResultName: z.string(),
  continueOnFailure: z.boolean(),
  body: z.array(leafStepFieldsSchema),
  then: z.array(leafStepFieldsSchema),
  else: z.array(leafStepFieldsSchema),
})
export type LeafStep = z.infer<typeof leafStepFieldsSchema>
export type WorkflowStep = z.infer<typeof workflowStepFieldsSchema>

export const ALL_CAPABILITIES: DurableCapabilities = {
  multipart: true,
  transactionMode: true,
  loopContinueOnFailure: true,
}

const MAX_TOTAL_LEAVES = 60
const IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/
const multipartPartsSchema = z
  .array(
    z.object({
      name: z.string().min(1),
      data_b64: z.string(),
      filename: z.string().optional(),
      content_type: z.string().optional(),
    })
  )
  .min(1)

type Path = (string | number)[]
type LeafContext = { inLoop: boolean; capabilities: DurableCapabilities }

const addIssue = (ctx: z.RefinementCtx, path: Path, message: string) =>
  ctx.addIssue({ code: 'custom', path, message })

function validateLeaf(step: LeafStep, ctx: z.RefinementCtx, path: Path, options: LeafContext) {
  const issue = (field: string, message: string) => addIssue(ctx, [...path, field], message)
  if (!/^$|^[a-zA-Z_][a-zA-Z0-9_]*$/.test(step.resultName))
    issue('resultName', $t('Use letters, numbers, and underscores for the result name'))
  const required = (field: 'query' | 'signal' | 'url') => {
    if (!step[field].trim()) issue(field, $t('This field is required'))
  }
  const validateSeconds = () => {
    const seconds = Number(step.seconds)
    if (
      !/^\d+$/.test(step.seconds) ||
      !Number.isSafeInteger(seconds) ||
      seconds < 1 ||
      seconds > 2147483647
    ) {
      issue('seconds', $t('Enter a whole number of seconds between 1 and 2147483647'))
    }
  }
  const validateHttpFields = () => {
    required('url')
    if (!z.string().url().safeParse(step.url).success || !/^https?:\/\//i.test(step.url)) {
      issue('url', $t('Enter an HTTP or HTTPS URL'))
    }
    try {
      z.record(z.string(), z.string()).parse(JSON.parse(step.headers))
    } catch {
      issue('headers', $t('Enter a JSON object with string header values'))
    }
    const timeout = Number(step.timeoutSeconds)
    if (!/^\d+$/.test(step.timeoutSeconds) || timeout < 1 || timeout > 3600) {
      issue('timeoutSeconds', $t('Enter a whole number of seconds between 1 and 3600'))
    }
  }

  if (step.type === 'sql') required('query')
  if (step.type === 'sleep') validateSeconds()
  if (step.type === 'signal') {
    required('signal')
    if (!step.noTimeout) validateSeconds()
  }
  if (step.type === 'http') validateHttpFields()
  if (step.type === 'multipart') {
    if (!options.capabilities.multipart) issue('type', $t('Requires pg_durable 0.2.5 or later'))
    validateHttpFields()
    let parts: unknown
    try {
      parts = JSON.parse(step.parts)
    } catch {
      parts = undefined
    }
    if (!multipartPartsSchema.safeParse(parts).success)
      issue('parts', $t('Enter a JSON array of parts, each with a name and base64 data'))
  }
  if (step.type === 'schedule') {
    const fields = step.cron.trim().split(/\s+/)
    if (fields.length !== 5 || !fields.every((field) => /^[0-9*,/-]+$/.test(field)))
      issue('cron', $t('Enter a five-field cron expression'))
  }
  if (step.type === 'break') {
    if (!options.inLoop) issue('type', $t('Break steps can only be used inside a loop'))
    if (step.breakValue) {
      try {
        JSON.parse(step.breakValue)
      } catch {
        issue('breakValue', $t('Enter valid JSON or leave this field empty'))
      }
    }
  }
}

function validateStep(
  step: WorkflowStep,
  ctx: z.RefinementCtx,
  path: Path,
  capabilities: DurableCapabilities
) {
  const validateChildren = (field: 'body' | 'then' | 'else', inLoop: boolean) =>
    step[field].forEach((child, index) =>
      validateLeaf(child, ctx, [...path, field, index], { inLoop, capabilities })
    )
  if ((LEAF_STEP_TYPES as readonly string[]).includes(step.type)) {
    validateLeaf(step as unknown as LeafStep, ctx, path, { inLoop: false, capabilities })
    return
  }
  if (!/^$|^[a-zA-Z_][a-zA-Z0-9_]*$/.test(step.resultName))
    addIssue(
      ctx,
      [...path, 'resultName'],
      $t('Use letters, numbers, and underscores for the result name')
    )
  if (step.type === 'loop') {
    if (step.body.length < 1) addIssue(ctx, [...path, 'body'], $t('Add at least one step'))
    if (step.continueOnFailure && !capabilities.loopContinueOnFailure)
      addIssue(ctx, [...path, 'continueOnFailure'], $t('Requires pg_durable 0.2.8 or later'))
    validateChildren('body', true)
  }
  if (step.type === 'if' || step.type === 'if_rows') {
    if (step.type === 'if' && !step.condition.trim())
      addIssue(ctx, [...path, 'condition'], $t('This field is required'))
    if (step.type === 'if_rows' && !IDENTIFIER_PATTERN.test(step.rowsResultName))
      addIssue(
        ctx,
        [...path, 'rowsResultName'],
        $t('Use letters, numbers, and underscores for the result name')
      )
    if (step.then.length < 1) addIssue(ctx, [...path, 'then'], $t('Add at least one step'))
    validateChildren('then', false)
    validateChildren('else', false)
  }
  if (step.type === 'race' || step.type === 'parallel') {
    if (step.body.length < 2) addIssue(ctx, [...path, 'body'], $t('Add at least two steps'))
    validateChildren('body', false)
  }
}

export const countLeafSteps = (steps: WorkflowStep[]) =>
  steps.reduce(
    (total, step) =>
      total +
      ((LEAF_STEP_TYPES as readonly string[]).includes(step.type)
        ? 1
        : step.body.length + step.then.length + step.else.length),
    0
  )

const createStepSchema = (capabilities: DurableCapabilities) =>
  workflowStepFieldsSchema.superRefine((step, ctx) => validateStep(step, ctx, [], capabilities))

/** Single-step validator with top-level semantics and every capability enabled. */
export const workflowStepSchema = createStepSchema(ALL_CAPABILITIES)
export const validateWorkflowStep = (step: WorkflowStep, capabilities: DurableCapabilities) =>
  createStepSchema(capabilities).safeParse(step)

export const createWorkflowFormSchema = (capabilities: DurableCapabilities) =>
  z
    .object({
      label: z.string().trim().max(200),
      mode: z.enum(['builder', 'expression']),
      composition: z.enum(['sequential', 'parallel']),
      transactionMode: z.enum(['caller', 'new']),
      expression: z.string(),
      steps: z.array(workflowStepFieldsSchema).min(1).max(30),
    })
    .superRefine((values, ctx) => {
      if (values.mode === 'builder') {
        values.steps.forEach((step, index) =>
          validateStep(step, ctx, ['steps', index], capabilities)
        )
        if (countLeafSteps(values.steps) > MAX_TOTAL_LEAVES)
          addIssue(ctx, ['steps'], $t('A workflow can have at most 60 steps in total'))
      }
      if (values.mode === 'expression' && !values.expression.trim()) {
        addIssue(ctx, ['expression'], $t('Enter a workflow expression'))
      }
      if (values.transactionMode === 'new' && !capabilities.transactionMode)
        addIssue(ctx, ['transactionMode'], $t('Requires pg_durable 0.2.5 or later'))
    })
export const workflowFormSchema = createWorkflowFormSchema(ALL_CAPABILITIES)
export type WorkflowFormValues = z.infer<typeof workflowFormSchema>

export const createDefaultLeafStep = (): LeafStep => ({
  type: 'sql',
  query: 'SELECT 1 AS result',
  seconds: '30',
  noTimeout: false,
  signal: 'approval',
  url: '',
  method: 'GET',
  requestBody: '',
  headers: '{}',
  timeoutSeconds: '30',
  parts: '[]',
  cron: '0 * * * *',
  breakValue: '',
  resultName: '',
})
export const createDefaultStep = (): WorkflowStep => ({
  ...createDefaultLeafStep(),
  condition: '',
  rowsResultName: '',
  continueOnFailure: false,
  body: [],
  then: [],
  else: [],
})
export const createDefaultContainer = (
  type: (typeof CONTAINER_STEP_TYPES)[number]
): WorkflowStep => ({
  ...createDefaultStep(),
  type,
  body:
    type === 'race' || type === 'parallel'
      ? [createDefaultLeafStep(), createDefaultLeafStep()]
      : type === 'loop'
        ? [createDefaultLeafStep()]
        : [],
  then: type === 'if' || type === 'if_rows' ? [createDefaultLeafStep()] : [],
})
export const workflowDefaultValues: WorkflowFormValues = {
  label: '',
  mode: 'builder',
  composition: 'sequential',
  transactionMode: 'caller',
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
      expression = safeSql`df.http(${literal(step.url)}, ${literal(step.method)}, ${literal(step.requestBody || null)}, ${literal(step.headers)}::jsonb, 30)`
      break
    default:
      throw new Error('Not implemented until Task 5')
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
