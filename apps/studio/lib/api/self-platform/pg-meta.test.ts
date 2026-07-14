import { describe, expect, it, vi } from 'vitest'

import { constructFleetPgMetaHeaders } from './pg-meta'
import { resolveProjectConnection } from './resolve-connection'

vi.mock('./resolve-connection', () => ({ resolveProjectConnection: vi.fn() }))
vi.mock('../apiHelpers', () => ({ constructHeaders: vi.fn((headers) => headers) }))

describe('constructFleetPgMetaHeaders', () => {
  it('overwrites an untrusted browser connection with the authorized project credential', async () => {
    vi.mocked(resolveProjectConnection).mockResolvedValue({
      pgConnEncrypted: 'SERVER_ENC',
    } as never)

    const headers = await constructFleetPgMetaHeaders('proj-b', {
      authorization: 'Bearer dashboard-session',
      'x-connection-encrypted': 'ATTACKER_ENC',
    })

    expect(resolveProjectConnection).toHaveBeenCalledWith('proj-b')
    expect(headers).toMatchObject({
      authorization: 'Bearer dashboard-session',
      'x-connection-encrypted': 'SERVER_ENC',
    })
  })
})
