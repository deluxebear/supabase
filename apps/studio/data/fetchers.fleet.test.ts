import { describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})

describe('Fleet pg-meta browser boundary', () => {
  it('strips x-connection-encrypted before the browser request leaves Studio', async () => {
    const { pgMetaGuard } = await import('./fetchers')
    const request = new Request('http://studio.test/platform/pg-meta/proj-b/tables', {
      headers: { 'x-connection-encrypted': 'STALE_ENC' },
    })

    const guarded = pgMetaGuard(request)

    expect(guarded.headers.has('x-connection-encrypted')).toBe(false)
    expect(guarded.headers.get('x-pg-application-name')).toBeTruthy()
  })
})
