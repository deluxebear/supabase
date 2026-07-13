import { describe, expect, it, vi } from 'vitest'

import { reconnectOperatorEvents } from './backup-operator-events'

vi.mock('@/data/fetchers', () => ({
  constructHeaders: vi.fn((headers?: HeadersInit) =>
    Promise.resolve(new Headers({ ...headers, Authorization: 'Bearer studio-session' }))
  ),
}))

describe('reconnectOperatorEvents', () => {
  it('continues from the latest SSE event id', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('id: 8\nevent: progress\ndata: {"progress":50}\n\n', {
        status: 200,
        headers: { 'Content-Type': 'text/event-stream' },
      })
    )

    const page = await reconnectOperatorEvents({
      projectRef: 'project-a',
      jobId: 'job-1',
      cursor: 7,
      refreshSnapshot: vi.fn(),
      fetcher,
    })

    expect(page).toEqual({
      cursor: 8,
      cursorExpired: false,
      events: [{ id: 8, type: 'progress', data: { progress: 50 } }],
    })
    expect(fetcher).toHaveBeenCalledWith(expect.stringContaining('cursor=7'), expect.any(Object))
    const requestHeaders = fetcher.mock.calls[0]?.[1]?.headers
    expect(fetcher.mock.calls[0]?.[1]?.cache).toBe('no-store')
    expect(new Headers(requestHeaders).get('Accept')).toBe('text/event-stream')
    expect(new Headers(requestHeaders).get('Authorization')).toBe('Bearer studio-session')
  })

  it('refreshes the job snapshot and reconnects from zero after cursor expiry', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json(
          { code: 'cursor_expired', details: { resume_from: 'snapshot' } },
          { status: 410 }
        )
      )
      .mockResolvedValueOnce(
        new Response('id: 12\nevent: state\ndata: {"state":"running"}\n\n', { status: 200 })
      )
    const refreshSnapshot = vi.fn().mockResolvedValue(undefined)

    const page = await reconnectOperatorEvents({
      projectRef: 'project-a',
      jobId: 'job-1',
      cursor: 4,
      refreshSnapshot,
      fetcher,
    })

    expect(refreshSnapshot).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]?.[0]).toContain('cursor=4')
    expect(fetcher.mock.calls[1]?.[0]).toContain('cursor=0')
    expect(page.cursor).toBe(12)
    expect(page.events).toEqual([{ id: 12, type: 'state', data: { state: 'running' } }])
  })
})
