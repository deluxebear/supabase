import { describe, expect, it } from 'vitest'

import { decodeFunctionLogEnvelope } from './function-log-envelope'

describe('function log transport envelope', () => {
  it('restores real request duration and worker correlation without changing older logs', () => {
    const row = {
      id: 'request-1',
      event_message: 'POST | 200 | /functions/v1/hello | 80.212 | worker-1',
    }
    expect(decodeFunctionLogEnvelope(row, 'project-d')).toMatchObject({
      id: 'request-1',
      execution_time_ms: 80.212,
      execution_id: 'worker-1',
      event_message: 'POST | 200 | /functions/v1/hello',
      function_id: 'project-d:hello',
      metadata: [{ request: { method: 'POST', pathname: '/functions/v1/hello' } }],
    })
    const old = { event_message: 'POST | 200 | /functions/v1/hello' }
    expect(decodeFunctionLogEnvelope(old, 'project-d')).toBe(old)
  })

  it('preserves Shutdown metadata and separators inside console messages', () => {
    const metadata = {
      event_type: 'Shutdown',
      event_message: 'shutdown | reason',
      function_id: 'project-d:hello',
      execution_id: 'worker-1',
      level: 'log',
      cpu_time_used: 44,
      memory_used: { total: 10959509, heap: 7862176, external: 3097333 },
    }
    const decoded = decodeFunctionLogEnvelope(
      {
        event_message: `Shutdown | hello | worker-1 | log | 44 | 10959509 | 7862176 | 3097333 | ${JSON.stringify(metadata)}`,
      },
      'project-d'
    )
    expect(decoded).toMatchObject({ ...metadata, metadata: [metadata] })
  })

  it.each([
    'invalid',
    'Shutdown | hello | worker-1 | log | 44 | 1 | 1 | 0 | {}',
    'POST | 200 | /functions/v1/hello | NaN | worker-1',
    'POST | 200 | /functions/v1/hello | -1 | worker-1',
  ])('keeps malformed payloads intact: %s', (event_message) => {
    const row = { event_message }
    expect(decodeFunctionLogEnvelope(row, 'project-d')).toBe(row)
  })
})
