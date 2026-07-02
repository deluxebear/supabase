import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { executeQuery } from './query'

vi.hoisted(() => {
  process.env.NEXT_PUBLIC_IS_PLATFORM = 'true'
  process.env.NEXT_PUBLIC_SELF_PLATFORM = 'true'
})
vi.mock('@/lib/api/self-platform/resolve-connection', () => ({
  resolveProjectConnection: vi
    .fn()
    .mockResolvedValue({ pgConnEncrypted: 'ENC-B', pgConnReadOnlyEncrypted: 'ENC-B-RO' }),
}))
vi.mock('./util', () => ({
  assertSelfHosted: vi.fn(),
  encryptString: vi.fn((s) => `ENC:${s}`),
  getConnectionString: vi.fn(({ readOnly }) =>
    readOnly ? 'postgresql://readonly@localhost/db' : 'postgresql://readwrite@localhost/db'
  ),
}))

beforeEach(() =>
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }))
  )
)
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('executeQuery projectRef', () => {
  it('uses the resolved encrypted DSN when projectRef given', async () => {
    vi.clearAllMocks()

    await executeQuery({ query: 'select 1', projectRef: 'proj-b' })
    const init = (globalThis.fetch as any).mock.calls[0][1]
    expect(new Headers(init.headers).get('x-connection-encrypted')).toBe('ENC-B')
  })
  it('uses read-only DSN when readOnly + projectRef', async () => {
    vi.clearAllMocks()

    await executeQuery({ query: 'select 1', projectRef: 'proj-b', readOnly: true })
    const init = (globalThis.fetch as any).mock.calls.at(-1)[1]
    expect(new Headers(init.headers).get('x-connection-encrypted')).toBe('ENC-B-RO')
  })
  it('uses global-env encrypted DSN when no projectRef', async () => {
    const { resolveProjectConnection } = await import('@/lib/api/self-platform/resolve-connection')
    vi.clearAllMocks()

    await executeQuery({ query: 'select 1' })
    const init = (globalThis.fetch as any).mock.calls[0][1]
    expect(new Headers(init.headers).get('x-connection-encrypted')).toBe(
      'ENC:postgresql://readwrite@localhost/db'
    )
    expect(resolveProjectConnection).not.toHaveBeenCalled()
  })
  it('uses global-env read-only DSN when no projectRef + readOnly', async () => {
    const { resolveProjectConnection } = await import('@/lib/api/self-platform/resolve-connection')
    vi.clearAllMocks()

    await executeQuery({ query: 'select 1', readOnly: true })
    const init = (globalThis.fetch as any).mock.calls[0][1]
    expect(new Headers(init.headers).get('x-connection-encrypted')).toBe(
      'ENC:postgresql://readonly@localhost/db'
    )
    expect(resolveProjectConnection).not.toHaveBeenCalled()
  })
})
