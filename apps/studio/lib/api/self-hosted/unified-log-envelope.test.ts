import { describe, expect, it } from 'vitest'

import { decodeUnifiedLogEnvelope } from './unified-log-envelope'

const row = {
  id: 'id',
  timestamp: 1790726400000000,
  event_message:
    'UnifiedLog | edge function | 200 | success | POST | /functions/v1/hello |  | ' +
    JSON.stringify({
      event_message: 'hello | world',
      metadata: { execution_id: 'worker', execution_time_ms: 40 },
    }),
}

describe('unified log envelopes', () => {
  it('restores message, filters and raw metadata without splitting console messages', () => {
    expect(decodeUnifiedLogEnvelope(row)).toMatchObject({
      event_message: 'hello | world',
      status: 200,
      level: 'success',
      method: 'POST',
      pathname: '/functions/v1/hello',
      metadata: { execution_id: 'worker', execution_time_ms: 40 },
    })
  })
  it('leaves ordinary and malformed records untouched', () => {
    expect(decodeUnifiedLogEnvelope({ event_message: 'ordinary' })).toEqual({
      event_message: 'ordinary',
    })
    expect(decodeUnifiedLogEnvelope({ event_message: 'UnifiedLog | bad' })).toEqual({
      event_message: 'UnifiedLog | bad',
    })
  })
  it('restores separator-bearing paths', () => {
    const decoded = decodeUnifiedLogEnvelope({
      ...row,
      event_message: row.event_message.replace('/functions/v1/hello', '/hello%20%7C%20world'),
    })
    expect(decoded.pathname).toBe('/hello | world')
  })
})
