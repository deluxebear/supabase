import { generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { applyAuthConfig, getAuthApplyStatus } from './auth-apply'
import { DEFAULTS, SECRET_FIELDS } from './auth-config'
import { authEnvName } from './auth-runtime'
import { executePlatformQuery } from './db'
import { commitDesiredConfiguration } from './desired-state'
import { getAgentSecretRecipient, getProjectManagementBinding } from './management-trust'
import { sealedSecretKeyId, sealSecret } from './sealed-secret'

vi.mock('./attachment', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./attachment')>()),
  requireProjectCapability: vi.fn(),
}))
vi.mock('./db', () => ({ executePlatformQuery: vi.fn() }))
vi.mock('./desired-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./desired-state')>()),
  commitDesiredConfiguration: vi.fn(),
}))
vi.mock('./management-trust', () => ({
  getProjectManagementBinding: vi.fn(),
  getAgentSecretRecipient: vi.fn(),
}))
vi.mock('./ownership-policy', () => ({
  listProjectOwnershipPolicies: vi
    .fn()
    .mockResolvedValue([
      { domain: 'auth', ownershipMode: 'direct-managed', policyRevision: 1, casToken: 'x' },
    ]),
  setProjectOwnershipPolicy: vi.fn(),
}))
vi.mock('./auth-config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./auth-config')>()),
  readStoredAuthOverrides: vi.fn().mockResolvedValue({
    config: { SITE_URL: 'https://app.example.com' },
    secretFields: ['SMTP_PASS'],
  }),
  readStoredAuthSecrets: vi.fn().mockResolvedValue({ SMTP_PASS: 'hunter2' }),
}))
vi.mock('./sealed-secret', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sealed-secret')>()
  return { ...actual, sealSecret: vi.fn(actual.sealSecret) }
})
vi.mock('./secrets', () => ({ requirePlatformEncryptionKey: () => 'studio-key' }))

const publicKey = (
  generateKeyPairSync('x25519').publicKey.export({ format: 'der', type: 'spki' }) as Buffer
).subarray(12)
const request = { actor: 'user-1', correlationId: 'correlation-1' }

beforeEach(() => {
  vi.mocked(executePlatformQuery).mockResolvedValue({ data: [], error: undefined })
  vi.mocked(commitDesiredConfiguration).mockReset()
  vi.mocked(sealSecret).mockClear()
  vi.mocked(getProjectManagementBinding).mockResolvedValue({
    id: 'binding-1',
    projectRef: 'project-a',
    state: 'active',
    targetState: 'active',
    deploymentKind: 'kubernetes',
    managementTargetId: 'target-1',
  } as never)
  vi.mocked(getAgentSecretRecipient).mockResolvedValue({
    keyId: sealedSecretKeyId(publicKey),
    publicKey,
  })
})

describe('Auth settings on Kubernetes targets', () => {
  it('seals plain settings and secrets into the auth Secret', async () => {
    const status = await getAuthApplyStatus('project-a', request)
    expect(status).toMatchObject({
      availability: { isAvailable: true },
      state: 'pending',
      appliedFields: ['SITE_URL'],
      sealedSecretFields: ['SMTP_PASS'],
      skippedSecretFields: [],
    })

    await applyAuthConfig({
      projectRef: 'project-a',
      expectedGeneration: 0,
      confirmOwnership: false,
      idempotencyKey: 'key-1',
      ...request,
    })
    const committed = vi.mocked(commitDesiredConfiguration).mock.calls[0][0]
    expect(committed.desiredDocument).toMatchObject({
      adapter: 'kubernetes',
      kubernetes: { resources: [], secrets: [{ service: 'auth' }] },
    })
    expect(JSON.stringify(committed.desiredDocument)).not.toContain('hunter2')
    const sealed = vi.mocked(sealSecret).mock.calls.at(-1)?.[0]
    expect(sealed?.context).toMatchObject({ domain: 'auth', path: 'kubernetes/secrets/auth' })
    expect(JSON.parse(sealed?.plaintext ?? '{}')).toEqual({
      GOTRUE_SITE_URL: 'https://app.example.com',
      GOTRUE_SMTP_PASS: 'hunter2',
    })
  })
})

// The Deployment's `env` wins over the Fleet Secret's `envFrom`, so a name in
// both would be silently ignored. Keep the manifest and Studio in step.
describe('docker/k8s/single-project/11-core.yaml', () => {
  const manifest = readFileSync(
    path.resolve(__dirname, '../../../../../docker/k8s/single-project/11-core.yaml'),
    'utf8'
  )
  const authDeployment = manifest.slice(manifest.indexOf('metadata: { name: auth, namespace'))
  const container = authDeployment.slice(0, authDeployment.indexOf('readinessProbe:'))

  it('reads the Fleet auth Secret last with envFrom', () => {
    const envFrom = [...container.matchAll(/secretRef: \{ name: ([a-z0-9-]+)/g)].map(
      (match) => match[1]
    )
    expect(envFrom).toEqual(['auth-defaults', 'supabase-fleet-auth-secrets'])
  })

  it('sets no variable with env that Studio can deliver', () => {
    const envSection = container.slice(container.indexOf('          env:'))
    const names = [...envSection.matchAll(/- \{ name: ([A-Z0-9_]+),/g)].map((match) => match[1])
    expect(names).toContain('GOTRUE_JWT_SECRET')
    const deliverable = new Set(
      [...Object.keys(DEFAULTS), ...SECRET_FIELDS].map((field) => authEnvName(field))
    )
    expect(names.filter((name) => deliverable.has(name))).toEqual([])
  })
})
