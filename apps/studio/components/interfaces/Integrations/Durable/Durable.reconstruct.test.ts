import { describe, expect, it } from 'vitest'

import { reconstructExpression } from './Durable.reconstruct'
import { buildStep, createDefaultContainer, createDefaultLeafStep } from './Durable.utils'
import type { DurableNode } from '@/data/pg-durable/pg-durable.types'

const node = (overrides: Partial<DurableNode> & { node_id: string }): DurableNode => ({
  node_type: 'SQL',
  query: null,
  result_name: null,
  left_node: null,
  right_node: null,
  status: null,
  result: null,
  status_details: null,
  inferred_status: null,
  updated_at: null,
  ...overrides,
})

const sql = (id: string, query: string, extra: Partial<DurableNode> = {}) =>
  node({ node_id: id, node_type: 'SQL', query, ...extra })

const run = (root: string | null, nodes: DurableNode[]) => reconstructExpression(root, nodes)

describe('reconstructExpression leaves', () => {
  it('SQL', () => {
    expect(run('a', [sql('a', "SELECT 'x'")])).toEqual({ expression: "df.sql('SELECT ''x''')" })
  })

  it('SLEEP', () => {
    expect(run('a', [node({ node_id: 'a', node_type: 'SLEEP', query: '10' })])).toEqual({
      expression: 'df.sleep(10::bigint)',
    })
  })

  it('SLEEP rejects non-numeric', () => {
    expect(run('a', [node({ node_id: 'a', node_type: 'SLEEP', query: '1.5' })])).toHaveProperty(
      'error'
    )
  })

  it('SIGNAL with and without timeout', () => {
    const q = (timeout: number | null) =>
      JSON.stringify({ signal_name: 'go', timeout_seconds: timeout })
    expect(run('a', [node({ node_id: 'a', node_type: 'SIGNAL', query: q(null) })])).toEqual({
      expression: "df.wait_for_signal('go')",
    })
    expect(run('a', [node({ node_id: 'a', node_type: 'SIGNAL', query: q(60) })])).toEqual({
      expression: "df.wait_for_signal('go', 60::integer)",
    })
  })

  it('WAIT_SCHEDULE', () => {
    expect(
      run('a', [
        node({
          node_id: 'a',
          node_type: 'WAIT_SCHEDULE',
          query: JSON.stringify({ cron_expr: '*/5 * * * *' }),
        }),
      ])
    ).toEqual({ expression: "df.wait_for_schedule('*/5 * * * *')" })
  })

  it('HTTP with body and headers, and with nulls (timeout defaults to 30)', () => {
    const full = JSON.stringify({
      url: 'https://x.test',
      method: 'POST',
      body: '{"a":1}',
      headers: { 'X-A': 'b' },
      timeout_seconds: 10,
    })
    expect(run('a', [node({ node_id: 'a', node_type: 'HTTP', query: full })])).toEqual({
      expression: `df.http('https://x.test', 'POST', '{"a":1}', '{"X-A":"b"}'::jsonb, 10)`,
    })
    const bare = JSON.stringify({
      url: 'https://x.test',
      method: 'GET',
      body: null,
      headers: null,
      timeout_seconds: null,
    })
    expect(run('a', [node({ node_id: 'a', node_type: 'HTTP', query: bare })])).toEqual({
      expression: "df.http('https://x.test', 'GET', NULL, NULL, 30)",
    })
  })

  it('HTTP_MULTIPART', () => {
    const q = JSON.stringify({
      url: 'https://x.test',
      method: 'POST',
      parts: [{ name: 'f', value: 'v' }],
      headers: null,
      timeout_seconds: 5,
    })
    expect(run('a', [node({ node_id: 'a', node_type: 'HTTP_MULTIPART', query: q })])).toEqual({
      expression: `df.http_multipart('https://x.test', 'POST', '[{"name":"f","value":"v"}]'::jsonb, NULL, 5)`,
    })
  })

  it('BREAK with and without value', () => {
    expect(
      run('a', [
        node({ node_id: 'a', node_type: 'BREAK', query: JSON.stringify({ break_value: null }) }),
      ])
    ).toEqual({ expression: 'df.break()' })
    expect(
      run('a', [
        node({ node_id: 'a', node_type: 'BREAK', query: JSON.stringify({ break_value: 'done' }) }),
      ])
    ).toEqual({ expression: "df.break('done')" })
  })

  it('wraps nodes that have a result_name', () => {
    expect(run('a', [sql('a', 'SELECT 1', { result_name: 'r' })])).toEqual({
      expression: "df.as(df.sql('SELECT 1'), 'r')",
    })
  })
})

describe('reconstructExpression compounds', () => {
  it('THEN', () => {
    expect(
      run('t', [
        node({ node_id: 't', node_type: 'THEN', left_node: 'a', right_node: 'b' }),
        sql('a', 'A'),
        sql('b', 'B'),
      ])
    ).toEqual({ expression: "df.seq(df.sql('A'), df.sql('B'))" })
  })

  it('preserves left-nested and right-nested THEN shapes and wraps them', () => {
    const nodes = [
      node({ node_id: 't1', node_type: 'THEN', left_node: 't2', right_node: 't3' }),
      node({ node_id: 't2', node_type: 'THEN', left_node: 'a', right_node: 'b', result_name: 'x' }),
      node({ node_id: 't3', node_type: 'THEN', left_node: 'c', right_node: 'd' }),
      sql('a', 'A'),
      sql('b', 'B'),
      sql('c', 'C'),
      sql('d', 'D'),
    ]
    expect(run('t1', nodes)).toEqual({
      expression:
        "df.seq(df.as(df.seq(df.sql('A'), df.sql('B')), 'x'), df.seq(df.sql('C'), df.sql('D')))",
    })
  })

  it('JOIN folds left over extra nodes; RACE', () => {
    const nodes = [
      node({
        node_id: 'j',
        node_type: 'JOIN',
        left_node: 'a',
        right_node: 'b',
        query: JSON.stringify({ extra_nodes: ['c'] }),
        result_name: 'all',
      }),
      sql('a', 'A'),
      sql('b', 'B'),
      sql('c', 'C'),
    ]
    expect(run('j', nodes)).toEqual({
      expression: "df.as(df.join(df.join(df.sql('A'), df.sql('B')), df.sql('C')), 'all')",
    })
    expect(
      run('r', [
        node({ node_id: 'r', node_type: 'RACE', left_node: 'a', right_node: 'b' }),
        sql('a', 'A'),
        sql('b', 'B'),
      ])
    ).toEqual({ expression: "df.race(df.sql('A'), df.sql('B'))" })
  })

  it('IF with condition node', () => {
    const nodes = [
      node({
        node_id: 'i',
        node_type: 'IF',
        left_node: 'a',
        right_node: 'b',
        query: JSON.stringify({ condition_node: 'c' }),
      }),
      sql('a', 'A'),
      sql('b', 'B'),
      sql('c', 'SELECT true'),
    ]
    expect(run('i', nodes)).toEqual({
      expression: "df.if(df.sql('SELECT true'), df.sql('A'), df.sql('B'))",
    })
  })

  it('IF rows keeps checked name distinct from capture name', () => {
    const nodes = [
      node({
        node_id: 'i',
        node_type: 'IF',
        left_node: 'a',
        right_node: 'b',
        result_name: 'cap',
        query: JSON.stringify({ condition_type: 'result_has_rows', result_name: 'checked' }),
      }),
      sql('a', 'A'),
      sql('b', 'B'),
    ]
    expect(run('i', nodes)).toEqual({
      expression: "df.as(df.if_rows('checked', df.sql('A'), df.sql('B')), 'cap')",
    })
  })

  it('LOOP variants', () => {
    const body = sql('b', 'B')
    const loop = (query: unknown) =>
      node({
        node_id: 'l',
        node_type: 'LOOP',
        left_node: 'b',
        query: query === null ? null : JSON.stringify(query),
      })
    expect(run('l', [loop(null), body])).toEqual({ expression: "df.loop(df.sql('B'))" })
    expect(run('l', [loop({ continue_on_failure: true }), body])).toEqual({
      expression: "df.loop(df.sql('B'), continue_on_failure => true)",
    })
    expect(
      run('l', [
        loop({ condition_node: 'c', continue_on_failure: true }),
        body,
        sql('c', 'SELECT 1'),
      ])
    ).toEqual({
      expression: "df.loop(df.sql('B'), df.sql('SELECT 1'), continue_on_failure => true)",
    })
  })

  it('nested combination: loop containing then(if, race)', () => {
    const nodes = [
      node({
        node_id: 'l',
        node_type: 'LOOP',
        left_node: 't',
        query: JSON.stringify({ condition_node: 'c' }),
      }),
      node({ node_id: 't', node_type: 'THEN', left_node: 'i', right_node: 'r' }),
      node({
        node_id: 'i',
        node_type: 'IF',
        left_node: 'a',
        right_node: 'b',
        query: JSON.stringify({ condition_type: 'result_has_rows', result_name: 'q' }),
      }),
      node({ node_id: 'r', node_type: 'RACE', left_node: 'a2', right_node: 'b2' }),
      sql('a', 'A'),
      sql('b', 'B'),
      sql('a2', 'A2'),
      sql('b2', 'B2'),
      sql('c', 'C'),
    ]
    expect(run('l', nodes)).toEqual({
      expression:
        "df.loop(df.seq(df.if_rows('q', df.sql('A'), df.sql('B')), df.race(df.sql('A2'), df.sql('B2'))), df.sql('C'))",
    })
  })

  it('finds the root when rootId is not given', () => {
    expect(
      run(null, [
        sql('a', 'A'),
        node({ node_id: 't', node_type: 'THEN', left_node: 'a', right_node: 'b' }),
        sql('b', 'B'),
      ])
    ).toEqual({ expression: "df.seq(df.sql('A'), df.sql('B'))" })
  })

  it('handles a 5000-node right-nested THEN chain without overflow', () => {
    const n = 5000
    const nodes: DurableNode[] = []
    for (let i = 0; i < n; i++) {
      nodes.push(
        node({
          node_id: `t${i}`,
          node_type: 'THEN',
          left_node: `s${i}`,
          right_node: i === n - 1 ? `s${n}` : `t${i + 1}`,
        })
      )
    }
    for (let i = 0; i <= n; i++) nodes.push(sql(`s${i}`, `SELECT ${i}`))
    const result = run('t0', nodes)
    expect(result).toHaveProperty('expression')
    const expression = (result as { expression: string }).expression
    expect(expression.startsWith("df.seq(df.sql('SELECT 0'), df.seq(")).toBe(true)
    expect(
      expression.endsWith("df.sql('SELECT 4999'), df.sql('SELECT 5000')" + ')'.repeat(n))
    ).toBe(true)
  })

  it('handles a 5000-node left-nested THEN chain without overflow', () => {
    const n = 5000
    const nodes: DurableNode[] = []
    for (let i = 0; i < n; i++) {
      nodes.push(
        node({
          node_id: `t${i}`,
          node_type: 'THEN',
          left_node: i === n - 1 ? `s0` : `t${i + 1}`,
          right_node: `s${i + 1}`,
        })
      )
    }
    for (let i = 0; i <= n; i++) nodes.push(sql(`s${i}`, `SELECT ${i}`))
    expect(run('t0', nodes)).toHaveProperty('expression')
  })
})

describe('reconstructExpression round trips with buildStep', () => {
  const leaf = (query: string, resultName = '') => ({
    ...createDefaultLeafStep(),
    type: 'sql' as const,
    query,
    resultName,
  })

  it('loop with condition and continue_on_failure', () => {
    const step = {
      ...createDefaultContainer('loop'),
      body: [leaf('A')],
      condition: 'SELECT true',
      continueOnFailure: true,
    }
    const nodes = [
      node({
        node_id: 'l',
        node_type: 'LOOP',
        left_node: 'a',
        query: JSON.stringify({ condition_node: 'c', continue_on_failure: true }),
      }),
      sql('a', 'A'),
      sql('c', 'SELECT true'),
    ]
    // Builder passes the loop condition as a literal string; reconstruction emits a node.
    expect(String(buildStep(step))).toBe(
      "df.loop(df.sql('A'), 'SELECT true', continue_on_failure => true)"
    )
    expect(run('l', nodes)).toEqual({
      expression: "df.loop(df.sql('A'), df.sql('SELECT true'), continue_on_failure => true)",
    })
  })

  it('if with both arms: builder literal condition vs reconstructed condition node', () => {
    const step = {
      ...createDefaultContainer('if'),
      condition: 'SELECT 1',
      then: [leaf('A')],
      else: [leaf('B')],
    }
    const nodes = [
      node({
        node_id: 'i',
        node_type: 'IF',
        left_node: 'a',
        right_node: 'b',
        query: JSON.stringify({ condition_node: 'c' }),
      }),
      sql('a', 'A'),
      sql('b', 'B'),
      sql('c', 'SELECT 1'),
    ]
    expect(String(buildStep(step))).toBe("df.if('SELECT 1', df.sql('A'), df.sql('B'))")
    expect(run('i', nodes)).toEqual({
      expression: "df.if(df.sql('SELECT 1'), df.sql('A'), df.sql('B'))",
    })
  })

  it('if_rows', () => {
    const step = {
      ...createDefaultContainer('if_rows'),
      rowsResultName: 'rows',
      then: [leaf('A')],
      else: [leaf('B')],
    }
    const nodes = [
      node({
        node_id: 'i',
        node_type: 'IF',
        left_node: 'a',
        right_node: 'b',
        query: JSON.stringify({ condition_type: 'result_has_rows', result_name: 'rows' }),
      }),
      sql('a', 'A'),
      sql('b', 'B'),
    ]
    expect(run('i', nodes)).toEqual({ expression: String(buildStep(step)) })
  })

  it('3-way race as a left fold', () => {
    const step = { ...createDefaultContainer('race'), body: [leaf('A'), leaf('B'), leaf('C')] }
    const nodes = [
      node({ node_id: 'r2', node_type: 'RACE', left_node: 'r1', right_node: 'c' }),
      node({ node_id: 'r1', node_type: 'RACE', left_node: 'a', right_node: 'b' }),
      sql('a', 'A'),
      sql('b', 'B'),
      sql('c', 'C'),
    ]
    expect(run('r2', nodes)).toEqual({ expression: String(buildStep(step)) })
  })

  it('parallel with resultName', () => {
    const step = {
      ...createDefaultContainer('parallel'),
      resultName: 'p',
      body: [leaf('A'), leaf('B'), leaf('C')],
    }
    const nodes = [
      node({
        node_id: 'j',
        node_type: 'JOIN',
        left_node: 'a',
        right_node: 'b',
        result_name: 'p',
        query: JSON.stringify({ extra_nodes: ['c'] }),
      }),
      sql('a', 'A'),
      sql('b', 'B'),
      sql('c', 'C'),
    ]
    expect(run('j', nodes)).toEqual({ expression: String(buildStep(step)) })
  })
})

describe('reconstructExpression errors', () => {
  it('unknown type', () => {
    expect(run('a', [node({ node_id: 'a', node_type: 'FOO' })])).toEqual({
      error: 'Unsupported step type FOO',
    })
  })

  it('THEN missing right', () => {
    const result = run('t', [
      node({ node_id: 't', node_type: 'THEN', left_node: 'a' }),
      sql('a', 'A'),
    ])
    expect(result).toHaveProperty('error')
  })

  it('missing referenced node', () => {
    expect(
      run('t', [
        node({ node_id: 't', node_type: 'THEN', left_node: 'a', right_node: 'zz' }),
        sql('a', 'A'),
      ])
    ).toEqual({ error: 'Step zz is missing' })
  })

  it('IF without condition or condition_type', () => {
    const result = run('i', [
      node({ node_id: 'i', node_type: 'IF', left_node: 'a', right_node: 'b', query: '{}' }),
      sql('a', 'A'),
      sql('b', 'B'),
    ])
    expect(result).toHaveProperty('error')
  })

  it('cycle', () => {
    const result = run('t1', [
      node({ node_id: 't1', node_type: 'THEN', left_node: 'a', right_node: 't2' }),
      node({ node_id: 't2', node_type: 'THEN', left_node: 'a', right_node: 't1' }),
      sql('a', 'A'),
    ])
    expect(result).toEqual({ error: 'The workflow graph contains a cycle' })
  })

  it('cycle through a compound node', () => {
    const result = run('r', [
      node({ node_id: 'r', node_type: 'RACE', left_node: 'a', right_node: 'r' }),
      sql('a', 'A'),
    ])
    expect(result).toEqual({ error: 'The workflow graph contains a cycle' })
  })

  it('empty list', () => {
    expect(run(null, [])).toHaveProperty('error')
    expect(run('x', [])).toHaveProperty('error')
  })
})
