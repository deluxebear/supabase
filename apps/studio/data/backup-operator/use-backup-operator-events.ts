import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { reconnectOperatorEvents, type OperatorEvent } from './backup-operator-events'
import { operatorJobQueryOptions } from './backup-operator-query'

const reconnectDelay = 2_000

export function useBackupOperatorEvents({
  projectRef,
  jobId,
}: {
  projectRef?: string
  jobId?: string
}) {
  const queryClient = useQueryClient()
  const [events, setEvents] = useState<OperatorEvent[]>([])
  const [error, setError] = useState<Error>()

  useEffect(() => {
    if (!projectRef || !jobId) return
    const controller = new AbortController()
    const storageKey = `backup-operator:${projectRef}:${jobId}:cursor`
    let cursor = Number(globalThis.sessionStorage?.getItem(storageKey) ?? 0)
    let timer: ReturnType<typeof setTimeout> | undefined

    const reconnect = async () => {
      try {
        const page = await reconnectOperatorEvents({
          projectRef,
          jobId,
          cursor,
          signal: controller.signal,
          refreshSnapshot: () =>
            queryClient.fetchQuery({
              ...operatorJobQueryOptions({ projectRef, jobId }),
              staleTime: 0,
            }),
        })
        cursor = page.cursor
        globalThis.sessionStorage?.setItem(storageKey, String(cursor))
        if (page.events.length > 0) {
          setEvents((current) => [...current, ...page.events].slice(-100))
          await queryClient.invalidateQueries({
            queryKey: operatorJobQueryOptions({ projectRef, jobId }).queryKey,
          })
        }
        setError(undefined)
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause : new Error('Failed to reconnect to job events'))
        }
      }
      if (!controller.signal.aborted) timer = setTimeout(reconnect, reconnectDelay)
    }

    void reconnect()
    return () => {
      controller.abort()
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [jobId, projectRef, queryClient])

  return { events, error }
}
