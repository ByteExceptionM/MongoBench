import { create } from 'zustand'

export type RevealTarget = {
  connectionId: string
  db?: string
  coll?: string
}

type ExplorerState = {
  expandedConnections: Set<string>
  /** Keys are `${connectionId}::${db}`. */
  expandedDatabases: Set<string>
  /**
   * Last requested reveal. Read together with `revealNonce` so consumers can
   * react to re-issuing the same target (e.g. picking the same collection
   * twice in the palette still scrolls the sidebar).
   */
  revealTarget: RevealTarget | null
  revealNonce: number

  expandConnection: (id: string) => void
  collapseConnection: (id: string) => void
  toggleConnection: (id: string) => void
  expandDatabase: (connectionId: string, db: string) => void
  toggleDatabase: (connectionId: string, db: string) => void
  /**
   * Mark a connection (and optionally a database) as expanded and signal any
   * matching row to scroll itself into view.
   */
  reveal: (target: RevealTarget) => void
}

const dbKey = (connectionId: string, db: string): string => `${connectionId}::${db}`

export const useExplorerStore = create<ExplorerState>((set) => ({
  expandedConnections: new Set<string>(),
  expandedDatabases: new Set<string>(),
  revealTarget: null,
  revealNonce: 0,

  expandConnection: (id) =>
    set((s) => {
      if (s.expandedConnections.has(id)) return s
      const next = new Set(s.expandedConnections)
      next.add(id)
      return { expandedConnections: next }
    }),
  collapseConnection: (id) =>
    set((s) => {
      if (!s.expandedConnections.has(id)) return s
      const next = new Set(s.expandedConnections)
      next.delete(id)
      return { expandedConnections: next }
    }),
  toggleConnection: (id) =>
    set((s) => {
      const next = new Set(s.expandedConnections)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { expandedConnections: next }
    }),
  expandDatabase: (connectionId, db) =>
    set((s) => {
      const k = dbKey(connectionId, db)
      if (s.expandedDatabases.has(k)) return s
      const next = new Set(s.expandedDatabases)
      next.add(k)
      return { expandedDatabases: next }
    }),
  toggleDatabase: (connectionId, db) =>
    set((s) => {
      const k = dbKey(connectionId, db)
      const next = new Set(s.expandedDatabases)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return { expandedDatabases: next }
    }),
  reveal: ({ connectionId, db, coll }) =>
    set((s) => {
      const expandedConnections = new Set(s.expandedConnections)
      expandedConnections.add(connectionId)
      const expandedDatabases = new Set(s.expandedDatabases)
      if (db) expandedDatabases.add(dbKey(connectionId, db))
      return {
        expandedConnections,
        expandedDatabases,
        revealTarget: { connectionId, db, coll },
        revealNonce: s.revealNonce + 1
      }
    })
}))
