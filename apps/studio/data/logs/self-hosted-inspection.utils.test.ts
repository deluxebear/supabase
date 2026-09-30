import { describe, expect, it } from 'vitest'

import { flattenSelfHostedInspection } from './self-hosted-inspection.utils'

describe('self-hosted inspection', () => {
  it('preserves real request and worker fields for the detail panel', () => {
    const entry = flattenSelfHostedInspection([
      {
        id: 'id',
        timestamp: 1790726400000000,
        log_type: 'edge function',
        status: '200',
        level: 'success',
        pathname: '/functions/v1/hello',
        method: 'POST',
        event_message: 'request',
        log_count: null,
        logs: null,
        metadata: {
          execution_id: 'worker',
          execution_time_ms: 40,
          request: { headers: { user_agent: 'test' } },
        },
      },
    ])
    expect(entry).toMatchObject({
      execution_id: 'worker',
      execution_time_ms: '40',
      request_method: 'POST',
      request_path: '/functions/v1/hello',
      headers_user_agent: 'test',
    })
    expect(entry?.raw_log_data).toMatchObject({ metadata: { execution_id: 'worker' } })
  })
  it('handles no result and rejects malformed external data', () => {
    expect(flattenSelfHostedInspection([])).toBeUndefined()
    expect(() => flattenSelfHostedInspection([{ id: 1 }])).toThrow()
  })
})
