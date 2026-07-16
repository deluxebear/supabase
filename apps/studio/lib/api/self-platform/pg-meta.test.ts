import { describe, expect, it, vi } from 'vitest'

import { getProjectPgMetaBaseUrl, resolveFleetPgMetaRequest } from './pg-meta'
import { resolveProjectConnection } from './resolve-connection'

vi.mock('./resolve-connection', () => ({ resolveProjectConnection: vi.fn() }))
vi.mock('../apiHelpers', () => ({ constructHeaders: vi.fn((headers) => headers) }))

describe('project pg-meta routing', () => {
  it('derives the project-owned pg-meta endpoint from the registered gateway', () => {
    expect(getProjectPgMetaBaseUrl('https://stack.example.com/')).toBe(
      'https://stack.example.com/pg'
    )
  })

  it('overwrites browser credentials with the authorized project credentials', async () => {
    vi.mocked(resolveProjectConnection).mockResolvedValue({
      supabaseUrl: 'https://stack.example.com',
      serviceKey: 'PROJECT_SERVICE_KEY',
      pgConnEncrypted: 'SERVER_ENC',
      pgConnReadOnlyEncrypted: 'SERVER_RO_ENC',
    } as never)

    const target = await resolveFleetPgMetaRequest('proj-b', {
      authorization: 'Bearer dashboard-session',
      'x-connection-encrypted': 'ATTACKER_ENC',
    })

    expect(resolveProjectConnection).toHaveBeenCalledWith('proj-b')
    expect(target.baseUrl).toBe('https://stack.example.com/pg')
    expect(target.headers).toMatchObject({
      Authorization: 'Bearer PROJECT_SERVICE_KEY',
      apiKey: 'PROJECT_SERVICE_KEY',
      'x-connection-encrypted': 'SERVER_ENC',
    })
  })

  it('uses the registered read-only credential when requested', async () => {
    vi.mocked(resolveProjectConnection).mockResolvedValue({
      supabaseUrl: 'https://stack.example.com',
      serviceKey: 'PROJECT_SERVICE_KEY',
      pgConnEncrypted: 'SERVER_ENC',
      pgConnReadOnlyEncrypted: 'SERVER_RO_ENC',
    } as never)

    const target = await resolveFleetPgMetaRequest('proj-b', {}, { readOnly: true })

    expect(target.headers).toMatchObject({ 'x-connection-encrypted': 'SERVER_RO_ENC' })
  })
})
