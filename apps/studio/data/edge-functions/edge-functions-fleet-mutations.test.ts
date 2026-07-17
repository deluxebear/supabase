import { beforeEach, describe, expect, it, vi } from 'vitest'

import { deleteEdgeFunction } from './edge-functions-delete-mutation'
import { deployEdgeFunction } from './edge-functions-deploy-mutation'

vi.mock('@/lib/constants/deployment-profile', () => ({
  STUDIO_DEPLOYMENT_PROFILE: 'fleet',
}))
vi.mock('@/lib/helpers', () => ({ uuidv4: vi.fn(() => 'fleet-operation-uuid') }))
vi.mock('@/data/fetchers', () => ({
  constructHeaders: vi.fn(async (headers = {}) => headers),
  del: vi.fn(),
  handleError: vi.fn(),
  post: vi.fn(),
}))

describe('Fleet Edge Function mutations in insecure browser contexts', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.stubGlobal('crypto', {})
  })

  it('deploys without relying on crypto.randomUUID', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ deployment: { slug: 'hello', generation: 1 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      deployEdgeFunction({
        projectRef: 'project-a',
        slug: 'hello',
        expectedGeneration: 7,
        metadata: { entrypoint_path: 'index.ts' },
        files: [{ name: 'index.ts', content: 'Deno.serve(() => new Response("ok"))' }],
      })
    ).resolves.toMatchObject({ deployment: { slug: 'hello', generation: 1 } })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/platform/fleet/v1/projects/project-a/functions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'Idempotency-Key': 'fleet-operation-uuid' }),
        body: expect.stringContaining('"expectedGeneration":7'),
      })
    )
  })

  it('deletes without relying on crypto.randomUUID', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ deployment: { slug: 'hello', generation: 2 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      deleteEdgeFunction({ projectRef: 'project-a', slug: 'hello', expectedGeneration: 1 })
    ).resolves.toMatchObject({ deployment: { slug: 'hello', generation: 2 } })

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/platform/fleet/v1/projects/project-a/functions',
      expect.objectContaining({
        method: 'DELETE',
        headers: expect.objectContaining({ 'Idempotency-Key': 'fleet-operation-uuid' }),
      })
    )
  })
})
