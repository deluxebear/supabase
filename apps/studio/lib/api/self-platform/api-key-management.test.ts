import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createManagedAPIKey,
  listManagedAPIKeys,
  mutateManagedAPIKeys,
  renderManagedAPIKeys,
} from './api-key-management'
import { executePlatformQuery } from './db'
import { readVerifiedJWTObservation } from './jwt-configuration'
import { commitServiceConfigApply, loadServiceConfigApplyPlan } from './service-config-apply'

vi.mock('./db', () => ({ executePlatformQuery: vi.fn() }))
vi.mock('./resolve-connection', () => ({
  resolveProjectConnection: vi
    .fn()
    .mockResolvedValue({
      anonKey: 'anon',
      serviceKey: 'service',
      publishableKey: 'sb_publishable_existing',
      secretKey: null,
    }),
}))
vi.mock('./secrets', () => ({
  encryptSecret: (value: string) => `encrypted:${value}`,
  decryptSecret: (value: string) => value.slice(10),
}))
vi.mock('./jwt-configuration', () => ({ readVerifiedJWTObservation: vi.fn() }))
vi.mock('./service-config-apply', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadServiceConfigApplyPlan: vi.fn(),
  commitServiceConfigApply: vi.fn(),
}))
vi.mock('../self-hosted/util', () => ({ assertSelfHosted: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(executePlatformQuery).mockResolvedValue({ data: [], error: undefined })
})

describe('Fleet managed API keys', () => {
  it('creates independent random keys of the requested role', () => {
    const a = createManagedAPIKey({ name: 'browser', type: 'publishable' })
    const b = createManagedAPIKey({ name: 'server', type: 'secret' })
    expect(a.api_key).toMatch(/^sb_publishable_[A-Za-z0-9_-]{43}$/)
    expect(b.api_key).toMatch(/^sb_secret_[A-Za-z0-9_-]{43}$/)
    expect(createManagedAPIKey({ name: 'server', type: 'secret' }).api_key).not.toBe(b.api_key)
    expect(b.prefix).toHaveLength(15)
    expect(renderManagedAPIKeys([a, b])).toBe(`${a.api_key}=publishable,${b.api_key}=secret`)
  })
  it('rejects Lua or shell injection in delivered key values', () => {
    const key = createManagedAPIKey({ name: 'server', type: 'secret' })
    for (const value of ['key"; os.exit()', 'sb_secret_x|injection', 'sb_secret_x\n'])
      expect(() => renderManagedAPIKeys([{ ...key, api_key: value }])).toThrow()
    expect(renderManagedAPIKeys([])).toBe('')
  })
  it('retains registered keys until an Agent revision is applied', async () => {
    const keys = await listManagedAPIKeys('project-d')
    expect(keys.map((key) => key.id)).toEqual(['anon', 'service_role', 'publishable'])
    const query = vi.mocked(executePlatformQuery).mock.calls[0][0]
    expect(query.query).toContain("summary.state = 'applied'")
    expect(query.parameters).toEqual(['project-d'])
  })
  it('lists the applied encrypted registry without restoring revoked environment keys', async () => {
    const key = createManagedAPIKey({ name: 'second', type: 'publishable' })
    vi.mocked(executePlatformQuery).mockResolvedValue({
      data: [
        {
          desired_document: {
            compose: {
              files: [{ path: 'registry.enc', content: `encrypted:${JSON.stringify([key])}` }],
            },
          },
        },
      ],
      error: undefined,
    })
    const keys = await listManagedAPIKeys('project-d')
    expect(keys.map((key) => key.id)).toEqual(['anon', 'service_role', key.id])
  })
  it('rejects writes before a compatible running gateway is observed', async () => {
    vi.mocked(readVerifiedJWTObservation).mockResolvedValue(null)
    await expect(
      mutateManagedAPIKeys({
        projectRef: 'project-d',
        change: { kind: 'create', input: { name: 'browser', type: 'publishable' } },
        request: { actor: 'owner', correlationId: 'test' },
        idempotencyKey: 'test',
      })
    ).rejects.toThrow('Upgrade the Fleet Agent')
    expect(commitServiceConfigApply).not.toHaveBeenCalled()
  })
  it('preserves existing keys and seals the complete gateway set before returning success', async () => {
    vi.mocked(readVerifiedJWTObservation).mockResolvedValue({
      credentials: { apiKeysGateway: true, gatewayAPIKeysManaged: false },
    } as never)
    vi.mocked(loadServiceConfigApplyPlan).mockResolvedValue({
      secretsPlan: {},
      expectedGeneration: 0,
    } as never)
    vi.mocked(commitServiceConfigApply).mockResolvedValue({ operationId: 'op-created' } as never)
    vi.mocked(executePlatformQuery).mockImplementation(async ({ query }) => ({
      data: query.includes('select state') ? [{ state: 'applied' }] : [],
      error: undefined,
    }))
    const key = await mutateManagedAPIKeys({
      projectRef: 'project-d',
      change: { kind: 'create', input: { name: 'server', type: 'secret' } },
      request: { actor: 'owner', correlationId: 'test' },
      idempotencyKey: 'test',
    })
    expect(key.api_key).toMatch(/^sb_secret_/)
    const plan = vi.mocked(loadServiceConfigApplyPlan).mock.calls[0][0]
    expect(plan.secretsEnv?.FLEET_API_KEYS).toContain('sb_publishable_existing=publishable')
    expect(plan.secretsEnv?.FLEET_API_KEYS).toContain(`${key.api_key}=secret`)
    expect(plan.plainFiles[0].content).toContain('encrypted:')
  })
})
