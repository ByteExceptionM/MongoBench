import { create } from 'zustand'

export type QueryMode = 'simple' | 'aggregation' | 'shell'

export type CollectionTab = {
  id: string
  connectionId: string
  db: string
  coll: string
  /** Which input surface is active for this tab. */
  mode: QueryMode
  filter: string
  /** EJSON object string. Empty = no projection. */
  projection: string
  /** EJSON object string. Empty = no explicit sort. */
  sort: string
  /** Aggregation pipeline source (mongosh-flavoured array, e.g. `[{ $match: ... }]`). */
  pipeline: string
  /** Shell command source (e.g. `db.coll.find({...}).limit(10)`). */
  shell: string
  skip: number
  /** 0 = no limit (return all matching documents). */
  limit: number
  /**
   * Bumped on every explicit Run. Part of the active query's queryKey so
   * pressing Run with unchanged params still refetches, while a tab
   * re-mount (switching back to this tab) does not.
   */
  runEpoch: number
}

export type QueryPatch = Partial<
  Pick<
    CollectionTab,
    'mode' | 'filter' | 'projection' | 'sort' | 'pipeline' | 'shell' | 'skip' | 'limit' | 'runEpoch'
  >
>

const DEFAULT_LIMIT = 100

const tabId = (connectionId: string, db: string, coll: string): string =>
  `${connectionId}::${db}::${coll}`

type TabsState = {
  tabs: CollectionTab[]
  activeTabId: string | null
  /**
   * Open or focus the tab for the given collection. When `filter` is provided,
   * a freshly opened tab starts with that filter, and an existing tab's filter
   * is overwritten (with `skip` reset). Used by features like cross-collection
   * ObjectId lookup that need to drop the user into a pre-filtered view.
   */
  open: (params: { connectionId: string; db: string; coll: string; filter?: string }) => void
  close: (id: string) => void
  activate: (id: string) => void
  setQuery: (id: string, patch: QueryPatch) => void
  closeForConnection: (connectionId: string) => void
  closeForCollection: (connectionId: string, db: string, coll: string) => void
  closeForDatabase: (connectionId: string, db: string) => void
  renameCollection: (connectionId: string, db: string, oldName: string, newName: string) => void
}

export const useTabsStore = create<TabsState>((set) => ({
  tabs: [],
  activeTabId: null,
  open: ({ connectionId, db, coll, filter }) =>
    set((state) => {
      const id = tabId(connectionId, db, coll)
      const existing = state.tabs.find((t) => t.id === id)
      if (existing) {
        if (filter !== undefined && filter !== existing.filter) {
          return {
            tabs: state.tabs.map((t) => (t.id === id ? { ...t, filter, skip: 0 } : t)),
            activeTabId: id
          }
        }
        return { activeTabId: id }
      }
      const tab: CollectionTab = {
        id,
        connectionId,
        db,
        coll,
        mode: 'simple',
        filter: filter ?? '',
        projection: '',
        sort: '',
        pipeline: '',
        shell: '',
        skip: 0,
        limit: DEFAULT_LIMIT,
        runEpoch: 0
      }
      return { tabs: [...state.tabs, tab], activeTabId: id }
    }),
  close: (id) =>
    set((state) => {
      const idx = state.tabs.findIndex((t) => t.id === id)
      if (idx === -1) return state
      const remaining = state.tabs.filter((t) => t.id !== id)
      let nextActive = state.activeTabId
      if (state.activeTabId === id) {
        nextActive = remaining[idx]?.id ?? remaining[idx - 1]?.id ?? null
      }
      return { tabs: remaining, activeTabId: nextActive }
    }),
  activate: (id) => set({ activeTabId: id }),
  setQuery: (id, patch) =>
    set((state) => ({
      tabs: state.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t))
    })),
  closeForConnection: (connectionId) =>
    set((state) => {
      const remaining = state.tabs.filter((t) => t.connectionId !== connectionId)
      const stillActive = remaining.some((t) => t.id === state.activeTabId)
      return {
        tabs: remaining,
        activeTabId: stillActive ? state.activeTabId : (remaining[0]?.id ?? null)
      }
    }),
  closeForCollection: (connectionId, db, coll) =>
    set((state) => {
      const remaining = state.tabs.filter(
        (t) => !(t.connectionId === connectionId && t.db === db && t.coll === coll)
      )
      const stillActive = remaining.some((t) => t.id === state.activeTabId)
      return {
        tabs: remaining,
        activeTabId: stillActive ? state.activeTabId : (remaining[0]?.id ?? null)
      }
    }),
  closeForDatabase: (connectionId, db) =>
    set((state) => {
      const remaining = state.tabs.filter((t) => !(t.connectionId === connectionId && t.db === db))
      const stillActive = remaining.some((t) => t.id === state.activeTabId)
      return {
        tabs: remaining,
        activeTabId: stillActive ? state.activeTabId : (remaining[0]?.id ?? null)
      }
    }),
  renameCollection: (connectionId, db, oldName, newName) =>
    set((state) => {
      const oldId = tabId(connectionId, db, oldName)
      const newId = tabId(connectionId, db, newName)
      let activeTabId = state.activeTabId
      const tabs = state.tabs.map((t) => {
        if (t.connectionId !== connectionId || t.db !== db || t.coll !== oldName) return t
        if (state.activeTabId === oldId) activeTabId = newId
        return { ...t, id: newId, coll: newName }
      })
      return { tabs, activeTabId }
    })
}))
