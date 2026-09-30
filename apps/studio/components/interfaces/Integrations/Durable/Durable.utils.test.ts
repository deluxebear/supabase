import { describe, expect, it } from 'vitest'

import {
  buildCancelWorkflow,
  buildSignalWorkflow,
  buildStartWorkflow,
  buildWorkflow,
  createDefaultStep,
  getWaitingSignalNames,
  isWorkflowActive,
  workflowDefaultValues,
  workflowFormSchema,
  workflowStepSchema,
} from './Durable.utils'

const step = createDefaultStep()

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
