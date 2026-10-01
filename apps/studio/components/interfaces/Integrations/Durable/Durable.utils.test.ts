import { describe, expect, it } from 'vitest'

import {
  buildCancelWorkflow,
  buildSignalWorkflow,
  buildStartWorkflow,
  buildWorkflow,
  createDefaultContainer,
  createDefaultLeafStep,
  createDefaultStep,
  createWorkflowFormSchema,
  getWaitingSignalNames,
  isWorkflowActive,
  validateWorkflowStep,
  workflowDefaultValues,
  workflowFormSchema,
  workflowStepSchema,
} from './Durable.utils'

const step = createDefaultStep()
const leaf = createDefaultLeafStep()
const caps = { multipart: true, transactionMode: true, loopContinueOnFailure: true }
const caps027 = { multipart: true, transactionMode: true, loopContinueOnFailure: false }
const noCaps = { multipart: false, transactionMode: false, loopContinueOnFailure: false }
const ok = (s: object, c = caps) => validateWorkflowStep({ ...step, ...s } as never, c).success

describe('durable workflow authoring', () => {
  it('keeps SQL, labels, and signal payloads inside escaped literals', () => {
    const query = "SELECT 'it''s'; -- $variable \\ test"
    expect(buildWorkflow([{ ...step, query }], 'sequential')).toContain(
      "df.sql(E'SELECT ''it''''s''; -- $variable \\\\ test')"
    )
    expect(
      buildStartWorkflow(buildWorkflow([step], 'sequential'), "nightly'; DROP TABLE users; --")
    ).toContain("'nightly''; DROP TABLE users; --'")
    expect(buildSignalWorkflow("id'", "approval'", "{'x': 'y'}")).toBe(
      "SELECT df.signal('id''', 'approval''', '{''x'': ''y''}') AS value;"
    )
    expect(buildCancelWorkflow("id' OR true --")).toContain("'id'' OR true --'")
  })
  it('composes steps in order and preserves named results', () => {
    expect(
      buildWorkflow(
        [
          { ...step, resultName: 'first' },
          { ...step, type: 'sleep', seconds: '10' },
        ],
        'sequential'
      )
    ).toBe("df.seq(df.as(df.sql('SELECT 1 AS result'), 'first'), df.sleep(10::bigint))")
    expect(buildWorkflow([step, step], 'parallel')).toBe(
      "df.join(df.sql('SELECT 1 AS result'), df.sql('SELECT 1 AS result'))"
    )
  })
  it.each(['', '0', '-1', '1.5', 'NaN', '1; select 1', '2147483648'])(
    'rejects invalid duration %s',
    (seconds) => {
      expect(workflowStepSchema.safeParse({ ...step, type: 'sleep', seconds }).success).toBe(false)
    }
  )
  it('validates HTTP URLs and headers only for HTTP steps', () => {
    expect(
      workflowStepSchema.safeParse({ ...step, type: 'http', url: 'file:///tmp/test' }).success
    ).toBe(false)
    expect(
      workflowStepSchema.safeParse({
        ...step,
        type: 'http',
        url: 'https://example.com',
        headers: '{"x":2}',
      }).success
    ).toBe(false)
    expect(
      workflowStepSchema.safeParse({
        ...step,
        type: 'http',
        url: 'https://example.com',
        headers: '{"x":"2"}',
      }).success
    ).toBe(true)
    expect(workflowStepSchema.safeParse({ ...step, headers: 'not JSON' }).success).toBe(true)
  })
  it('does not validate hidden builder steps in expression mode', () => {
    const values = {
      ...workflowDefaultValues,
      expression: 'df.sleep(1)',
      steps: [{ ...step, type: 'http', url: '' }],
    }
    expect(workflowFormSchema.safeParse({ ...values, mode: 'builder' }).success).toBe(false)
    expect(workflowFormSchema.safeParse({ ...values, mode: 'expression' }).success).toBe(true)
  })
  it('rejects empty SQL and oversized workflows', () => {
    expect(workflowStepSchema.safeParse({ ...step, query: '  ' }).success).toBe(false)
    expect(() => buildWorkflow([], 'sequential')).toThrow()
    expect(() =>
      buildWorkflow(
        Array.from({ length: 31 }, () => step),
        'parallel'
      )
    ).toThrow()
  })
})

describe('durable workflow monitoring', () => {
  it('identifies active instances without offering cancellation for terminal states', () => {
    expect(isWorkflowActive('Running')).toBe(true)
    expect(isWorkflowActive('pending')).toBe(true)
    for (const status of ['completed', 'failed', 'cancelled', null, undefined])
      expect(isWorkflowActive(status)).toBe(false)
  })
  it('uses inferred signal status, deduplicates names, and ignores malformed definitions', () => {
    const signal = {
      node_type: 'SIGNAL',
      status: 'running',
      inferred_status: 'running',
      query: '{"signal_name":"approval"}',
    }
    expect(
      getWaitingSignalNames([
        signal,
        signal,
        { ...signal, inferred_status: 'completed' },
        { ...signal, query: 'invalid' },
        { ...signal, node_type: 'SQL' },
      ])
    ).toEqual(['approval'])
    expect(getWaitingSignalNames([{ ...signal, inferred_status: 'pending' }])).toEqual([])
  })
})

describe('durable control-flow step validation', () => {
  it('keeps the HTTP request body separate from container bodies', () => {
    expect(
      buildWorkflow(
        [{ ...step, type: 'http', url: 'https://x.dev', method: 'POST', requestBody: '{"a":1}' }],
        'sequential'
      )
    ).toBe("df.http('https://x.dev', 'POST', '{\"a\":1}', '{}'::jsonb, 30)")
  })
  it('validates signal seconds only without noTimeout', () => {
    expect(ok({ type: 'signal', noTimeout: true, seconds: '' })).toBe(true)
    expect(ok({ type: 'signal', noTimeout: false, seconds: '' })).toBe(false)
  })
  it.each([
    ['0', false],
    ['3601', false],
    ['1.5', false],
    ['60', true],
  ])('http timeoutSeconds %s -> %s', (timeoutSeconds, valid) => {
    expect(ok({ type: 'http', url: 'https://x.dev', timeoutSeconds })).toBe(valid)
  })
  it('validates multipart steps', () => {
    const base = { type: 'multipart', url: 'https://x.dev', method: 'POST' }
    expect(ok({ ...base, parts: '[{"name":"f","data_b64":"aGk="}]' })).toBe(true)
    expect(ok({ ...base, parts: '[{"name":"f","data_b64":"aGk="}]' }, noCaps)).toBe(false)
    for (const parts of ['[]', '{}', '[{"name":"f"}]']) expect(ok({ ...base, parts })).toBe(false)
  })
  it('validates schedule cron expressions', () => {
    expect(ok({ type: 'schedule', cron: '*/5 * * * *' })).toBe(true)
    for (const cron of ['* * * *', '@daily', 'a * * * *'])
      expect(ok({ type: 'schedule', cron })).toBe(false)
  })
  it('allows break only inside a loop', () => {
    expect(ok({ type: 'break' })).toBe(false)
    const loop = createDefaultContainer('loop')
    expect(ok({ ...loop, body: [{ ...leaf, type: 'break' }] })).toBe(true)
    expect(ok({ ...loop, body: [{ ...leaf, type: 'break', breakValue: '{bad' }] })).toBe(false)
    expect(ok({ ...loop, body: [{ ...leaf, type: 'break', breakValue: '"done"' }] })).toBe(true)
  })
  it('validates loops', () => {
    const loop = createDefaultContainer('loop')
    expect(ok({ ...loop, body: [] })).toBe(false)
    expect(ok({ ...loop, continueOnFailure: true }, caps027)).toBe(false)
    expect(ok({ ...loop, continueOnFailure: true }, caps)).toBe(true)
  })
  it('validates if and if_rows', () => {
    const iff = createDefaultContainer('if')
    expect(ok({ ...iff, condition: '' })).toBe(false)
    expect(ok({ ...iff, condition: 'SELECT true', else: [] })).toBe(true)
    const rows = createDefaultContainer('if_rows')
    expect(ok({ ...rows, rowsResultName: 'bad name' })).toBe(false)
    expect(ok({ ...rows, rowsResultName: 'rows_1' })).toBe(true)
    expect(ok({ ...rows, rowsResultName: 'rows_1', then: [] })).toBe(false)
  })
  it('requires at least two branches for race and parallel', () => {
    for (const type of ['race', 'parallel'] as const) {
      const c = createDefaultContainer(type)
      expect(c.body).toHaveLength(2)
      expect(ok(c)).toBe(true)
      expect(ok({ ...c, body: [leaf] })).toBe(false)
    }
  })
  it('enforces form-level limits and capabilities', () => {
    const schema = createWorkflowFormSchema(caps)
    const loopOf = (n: number) => ({
      ...createDefaultContainer('loop'),
      body: Array.from({ length: n }, () => leaf),
    })
    const values = (steps: unknown[]) => ({ ...workflowDefaultValues, steps })
    expect(schema.safeParse(values([loopOf(60)])).success).toBe(true)
    expect(schema.safeParse(values([loopOf(60), step])).success).toBe(false)
    const nonDefault = { ...workflowDefaultValues, transactionMode: 'new' as const }
    expect(schema.safeParse(nonDefault).success).toBe(true)
    expect(createWorkflowFormSchema(noCaps).safeParse(nonDefault).success).toBe(false)
    expect(workflowDefaultValues.transactionMode).toBe('caller')
  })
})
