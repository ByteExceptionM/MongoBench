import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { queryKeys } from '@/lib/queryClient'
import { useAppStore } from '@/store'
import { useServerStatsHistory } from '@/store/serverStatsHistory'

const SAMPLE_INTERVAL_MS = 5_000

type Poller = {
  handle: ReturnType<typeof setInterval>
  cancelled: boolean
}

/**
 * Background collector for `server.stats`. Mounted once at the app root.
 *
 * For every connection in `activeConnectionIds` we spin up an interval
 * that polls `serverStatus` every 5s and pushes the sample into
 * `useServerStatsHistory`. Pollers are torn down when the connection
 * disconnects, and the per-connection history is cleared so a fresh
 * connect starts with a clean window.
 *
 * The component renders nothing — it only owns timer lifecycle.
 */
export function ServerStatsCollector(): null {
  const activeIds = useAppStore((s) => s.activeConnectionIds)
  const push = useServerStatsHistory((s) => s.push)
  const clear = useServerStatsHistory((s) => s.clear)
  const queryClient = useQueryClient()
  const pollersRef = useRef(new Map<string, Poller>())

  useEffect(() => {
    const pollers = pollersRef.current

    // Start pollers for newly-active connections.
    for (const id of activeIds) {
      if (pollers.has(id)) continue

      const poller: Poller = {
        handle: 0 as unknown as ReturnType<typeof setInterval>,
        cancelled: false
      }

      const tick = async (): Promise<void> => {
        if (poller.cancelled) return
        try {
          const data = await api.server.stats(id)
          if (poller.cancelled) return
          push(id, { ts: Date.now(), data })
          // Mirror into react-query so the dashboard's `useQuery` doesn't
          // need its own polling interval and stays in sync without a
          // round-trip.
          queryClient.setQueryData(queryKeys.serverStats(id), data)
        } catch {
          // Server can transiently fail (auth not yet ready, election in
          // progress, etc.). Swallow and try again next tick — surfacing
          // toasts here would spam the user.
        }
      }

      void tick()
      poller.handle = setInterval(() => void tick(), SAMPLE_INTERVAL_MS)
      pollers.set(id, poller)
    }

    // Stop pollers for connections that just went inactive.
    for (const [id, poller] of pollers) {
      if (activeIds.has(id)) continue
      poller.cancelled = true
      clearInterval(poller.handle)
      pollers.delete(id)
      clear(id)
    }
  }, [activeIds, push, clear, queryClient])

  // Tear down everything on unmount (app close).
  useEffect(() => {
    const pollers = pollersRef.current
    return () => {
      for (const poller of pollers.values()) {
        poller.cancelled = true
        clearInterval(poller.handle)
      }
      pollers.clear()
    }
  }, [])

  return null
}
