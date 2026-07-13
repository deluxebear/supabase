import { BASE_PATH } from '@/lib/constants'

export type OperatorEvent = {
  id: number
  type: string
  data: unknown
}

type EventPage = {
  cursor: number
  events: OperatorEvent[]
  cursorExpired: boolean
}

const parseSSE = (body: string): OperatorEvent[] =>
  body
    .split(/\r?\n\r?\n/)
    .map((block) => {
      const lines = block.split(/\r?\n/)
      const id = Number(
        lines
          .find((line) => line.startsWith('id:'))
          ?.slice(3)
          .trim()
      )
      const type = lines
        .find((line) => line.startsWith('event:'))
        ?.slice(6)
        .trim()
      const data = lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (!Number.isSafeInteger(id) || !type || !data) return null
      try {
        return { id, type, data: JSON.parse(data) }
      } catch {
        return { id, type, data }
      }
    })
    .filter((event): event is OperatorEvent => event !== null)

async function getEventPage({
  projectRef,
  jobId,
  cursor,
  signal,
  fetcher,
}: {
  projectRef: string
  jobId: string
  cursor: number
  signal?: AbortSignal
  fetcher: typeof fetch
}): Promise<EventPage> {
  const response = await fetcher(
    `${BASE_PATH}/api/platform/database/${encodeURIComponent(projectRef)}/backup-operator/jobs/${encodeURIComponent(jobId)}/events?cursor=${cursor}`,
    { signal, headers: { Accept: 'text/event-stream' } }
  )
  if (response.status === 410) {
    const payload = await response.json().catch(() => null)
    if (payload && typeof payload === 'object' && payload.code === 'cursor_expired') {
      return { cursor: 0, events: [], cursorExpired: true }
    }
  }
  if (!response.ok) throw new Error(`Backup Operator events returned HTTP ${response.status}`)
  const events = parseSSE(await response.text())
  return {
    cursor: events.reduce((latest, event) => Math.max(latest, event.id), cursor),
    events,
    cursorExpired: false,
  }
}

export async function reconnectOperatorEvents({
  projectRef,
  jobId,
  cursor,
  refreshSnapshot,
  signal,
  fetcher = fetch,
}: {
  projectRef: string
  jobId: string
  cursor: number
  refreshSnapshot: () => Promise<unknown>
  signal?: AbortSignal
  fetcher?: typeof fetch
}): Promise<EventPage> {
  const page = await getEventPage({ projectRef, jobId, cursor, signal, fetcher })
  if (!page.cursorExpired) return page

  await refreshSnapshot()
  return getEventPage({ projectRef, jobId, cursor: 0, signal, fetcher })
}
