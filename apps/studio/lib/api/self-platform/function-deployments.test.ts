import { beforeEach, describe, expect, it, vi } from 'vitest'

import { requireProjectCapability } from './attachment'
import { executePlatformQuery } from './db'
import {
  buildFunctionArtifact,
  deployFunction,
  functionDeploymentInputSchema,
  listFunctionDeployments,
} from './function-deployments'
import { requestManagementDomain, syncProjectManagementBinding } from './management-trust'
import { listProjectOwnershipPolicies } from './ownership-policy'

vi.mock('./db', () => ({ executePlatformQuery: vi.fn() }))
vi.mock('./attachment', () => ({ requireProjectCapability: vi.fn() }))
vi.mock('./management-trust', async (importOriginal) => {
  const original = await importOriginal<typeof import('./management-trust')>()
  return {
    ...original,
    requestManagementDomain: vi.fn(),
    syncProjectManagementBinding: vi.fn(),
  }
})
vi.mock('./ownership-policy', () => ({ listProjectOwnershipPolicies: vi.fn() }))

function input(files = [{ name: 'index.ts', content: 'export default 1' }]) {
  return {
    slug: 'hello',
    expectedGeneration: 0,
    idempotencyKey: 'idem-a',
    metadata: { entrypointPath: 'index.ts', staticPatterns: [], verifyJwt: true },
    files,
  }
}

describe('Fleet function artifact validation', () => {
  beforeEach(() => vi.resetAllMocks())

  it('builds deterministic immutable artifacts independent of file order', () => {
    const first = buildFunctionArtifact(
      input([
        { name: 'index.ts', content: 'export default 1' },
        { name: 'lib/value.ts', content: 'export const value = 1' },
      ])
    )
    const second = buildFunctionArtifact(
      input([
        { name: 'lib/value.ts', content: 'export const value = 1' },
        { name: 'index.ts', content: 'export default 1' },
      ])
    )
    expect(second.digest).toBe(first.digest)
    expect(second.artifact.equals(first.artifact)).toBe(true)
  })

  it.each([
    [input([{ name: '../index.ts', content: 'escape' }]), 'path traversal'],
    [
      { ...input(), files: [{ name: 'index.ts', content: 'safe', symlink: '../../secret' }] },
      'symlink-shaped unknown field',
    ],
    [
      input([
        { name: 'index.ts', content: 'one' },
        { name: 'index.ts', content: 'two' },
      ]),
      'duplicate path',
    ],
    [
      { ...input(), metadata: { ...input().metadata, entrypointPath: 'missing.ts' } },
      'missing entrypoint',
    ],
  ])('rejects unsafe bundles: %s (%s)', (value, _label) => {
    expect(() => buildFunctionArtifact(value as never)).toThrow()
  })

  it('enforces the per-file limit in UTF-8 bytes, not JavaScript characters', () => {
    const multibyte = '你'.repeat(Math.floor((4 << 20) / 3) + 1)
    expect(() => buildFunctionArtifact(input([{ name: 'index.ts', content: multibyte }]))).toThrow(
      /bytes/
    )
  })

  it('keeps deployment inputs strict', () => {
    expect(
      functionDeploymentInputSchema.safeParse({ ...input(), archiveUrl: 'https://attacker.test/a' })
        .success
    ).toBe(false)
  })

  it('queries deployments with the exact project boundary', async () => {
    vi.mocked(executePlatformQuery).mockResolvedValue({
      data: [
        {
          project_ref: 'project-a',
          slug: 'hello',
          generation: 1,
          desired_revision: '11111111-1111-4111-8111-111111111111',
          desired_artifact_digest: 'a'.repeat(64),
          active_artifact_digest: null,
          previous_artifact_digest: null,
          operation_id: 'op-a',
          adapter: 'compose',
          state: 'queued',
          last_error_code: null,
          remediation: null,
          observed_at: null,
          created_at: '2026-07-15T00:00:00Z',
          updated_at: '2026-07-15T00:00:00Z',
        },
      ],
      error: null,
    } as never)
    const deployments = await listFunctionDeployments('project-a')
    expect(deployments).toHaveLength(1)
    expect(vi.mocked(executePlatformQuery).mock.calls[0][0].parameters).toEqual(['project-a'])
  })

  it('checks capability, active binding, ownership and project-scoped artifact upload before commit', async () => {
    const value = input()
    const built = buildFunctionArtifact(value)
    vi.mocked(requireProjectCapability).mockResolvedValue({} as never)
    vi.mocked(syncProjectManagementBinding).mockResolvedValue({
      state: 'active',
      targetState: 'active',
      deploymentKind: 'compose',
    } as never)
    vi.mocked(listProjectOwnershipPolicies).mockResolvedValue([
      { domain: 'functions', ownershipMode: 'direct-managed' },
    ] as never)
    vi.mocked(requestManagementDomain).mockResolvedValue({
      digest: built.digest,
      size: built.size,
    })
    vi.mocked(executePlatformQuery)
      .mockResolvedValueOnce({ data: [{ operation_id: 'op-a' }], error: null } as never)
      .mockResolvedValueOnce({
        data: [
          {
            project_ref: 'project-a',
            slug: 'hello',
            generation: 1,
            desired_revision: '11111111-1111-4111-8111-111111111111',
            desired_artifact_digest: built.digest,
            active_artifact_digest: null,
            previous_artifact_digest: null,
            operation_id: 'op-a',
            adapter: 'compose',
            state: 'queued',
            last_error_code: null,
            remediation: null,
            observed_at: null,
            created_at: '2026-07-15T00:00:00Z',
            updated_at: '2026-07-15T00:00:00Z',
          },
        ],
        error: null,
      } as never)
    await deployFunction({
      projectRef: 'project-a',
      value,
      actor: 'user-a',
      correlationId: 'request-a',
    })
    expect(syncProjectManagementBinding).toHaveBeenCalledWith({
      projectRef: 'project-a',
      actor: 'user-a',
      correlationId: 'request-a',
    })
    expect(requireProjectCapability).toHaveBeenCalledWith('project-a', 'functions.deploy')
    expect(vi.mocked(syncProjectManagementBinding).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(requireProjectCapability).mock.invocationCallOrder[0]
    )
    expect(listProjectOwnershipPolicies).toHaveBeenCalledWith('project-a')
    expect(requestManagementDomain).toHaveBeenCalledWith(
      expect.anything(),
      'fleet-control',
      expect.objectContaining({
        path: `/platform/fleet/v1/projects/project-a/function-artifacts/${built.digest}`,
        scopes: ['fleet.artifacts.write'],
      })
    )
  })
})
