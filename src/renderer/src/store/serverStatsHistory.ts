import { create } from 'zustand'
import type { ServerStats } from '@shared/types'

export type StatsSample = { ts: number; data: ServerStats }

/** ~15 minutes at one sample every 5 seconds. */
export const HISTORY_LIMIT = 180

/**
 * Per-connection sliding window of `serverStatus` samples.
 *
 * Populated by `ServerStatsCollector` (mounted at the app root) so that
 * the dashboard's sparkline history survives navigation away from the
 * dashboard tab — the user can browse a collection for ten minutes and
 * still come back to a populated chart.
 */
type State = {
  histories: Record<string, StatsSample[]>
  push: (connectionId: string, sample: StatsSample) => void
  clear: (connectionId: string) => void
}

export const useServerStatsHistory = create<State>((set) => ({
  histories: {},
  push: (connectionId, sample) =>
    set((state) => {
      const prev = state.histories[connectionId] ?? []
      const next = [...prev, sample]
      if (next.length > HISTORY_LIMIT) next.splice(0, next.length - HISTORY_LIMIT)
      return { histories: { ...state.histories, [connectionId]: next } }
    }),
  clear: (connectionId) =>
    set((state) => {
      if (!(connectionId in state.histories)) return state
      const { [connectionId]: _drop, ...rest } = state.histories
      return { histories: rest }
    })
}))
