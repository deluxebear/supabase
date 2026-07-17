import { describe, expect, it, vi } from 'vitest'

import { fetchBackupOperator, retryBackupOperatorQuery } from './backup-operator-fetch'
import { constructHeaders } from '@/data/fetchers'
import { ResponseError } from '@/types'

vi.mock('@/data/fetchers', () => ({
  constructHeaders: vi.fn(async (headers?: HeadersInit) => {
    const result = new Headers(headers)
    result.set('Authorization', 'Bearer platform-session')
    result.set('X-Request-Id', 'request-a')
    return result
  }),
}))

describe('fetchBackupOperator', () => {
  it('uses the shared Platform Auth headers while preserving request headers', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }))

    await fetchBackupOperator(
      '/api/platform/database/project-a/backup-operator/backups',
      { method: 'POST', headers: { 'Idempotency-Key': 'backup-a' } },
      fetcher
    )

    expect(constructHeaders).toHaveBeenCalledWith({ 'Idempotency-Key': 'backup-a' })
    const init = fetcher.mock.calls[0]?.[1]
    expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer platform-session')
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('backup-a')
  })

  it('does not retry explicit authorization failures', () => {
    expect(retryBackupOperatorQuery(0, new ResponseError('Authentication required', 401))).toBe(
      false
    )
    expect(retryBackupOperatorQuery(0, new ResponseError('Access denied', 403))).toBe(false)
    expect(retryBackupOperatorQuery(0, new ResponseError('Unavailable', 503))).toBe(true)
    expect(retryBackupOperatorQuery(2, new ResponseError('Unavailable', 503))).toBe(false)
  })

  it('does not retry deterministic response schema drift', () => {
    expect(retryBackupOperatorQuery(0, new Error('network failure'))).toBe(true)
    expect(
      retryBackupOperatorQuery(0, Object.assign(new Error('schema mismatch'), { name: 'ZodError' }))
    ).toBe(false)
  })
})
