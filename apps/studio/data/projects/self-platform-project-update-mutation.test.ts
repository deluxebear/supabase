import { describe, expect, it, vi } from 'vitest'

import { updateSelfPlatformProject } from './self-platform-project-update-mutation'
import { patch } from '@/data/fetchers'

vi.mock('@/data/fetchers', () => ({
  patch: vi
    .fn()
    .mockResolvedValue({ data: { ref: 'r', propagated_children: [] }, error: undefined }),
  handleError: vi.fn((e: unknown) => {
    throw e
  }),
}))

describe('updateSelfPlatformProject (M6.1)', () => {
  it('sends the self-platform PATCH body verbatim — nulls preserved, ref only in the path', async () => {
    await updateSelfPlatformProject({
      ref: 'proj-b',
      connection: { kongUrl: 'http://k2:8000', publishableKey: null },
      logflare: { url: null },
    })
    // [self-platform] `patch`'s openapi-fetch-generated type makes
    // `Parameters<>` collapse to `never` for vi.mocked(...).mock.calls,
    // same as post in edge-functions-last-hour-stats-query.test.ts:45-47 —
    // cast before destructuring (no behavior change).
    const [path, options] = vi.mocked(patch).mock.calls[0] as [string, unknown]
    expect(path).toBe('/platform/projects/{ref}')
    expect((options as { params: { path: { ref: string } } }).params.path).toEqual({
      ref: 'proj-b',
    })
    expect((options as { body: unknown }).body).toEqual({
      connection: { kongUrl: 'http://k2:8000', publishableKey: null },
      logflare: { url: null },
    })
  })

  it('name-only variables produce a name-only body', async () => {
    await updateSelfPlatformProject({ ref: 'proj-b', name: 'Renamed' })
    const [, options] = vi.mocked(patch).mock.calls[1] as [string, unknown]
    expect((options as { body: unknown }).body).toEqual({ name: 'Renamed' })
  })
})
