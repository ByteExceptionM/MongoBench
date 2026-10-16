import { create } from 'zustand'
import type { CollectionRef } from '@shared/types'

export type QueryMode = 'simple' | 'aggregation' | 'shell'

/** Editor contents of a tab; nothing here has been executed. */
export type QueryDraft = {
  /** Visible input surface; switching it never runs a query. */
  mode: QueryMode
  filter: string
  projection: string
  sort: string
  pipeline: string
  shell: string
  /** Raw limit input; empty, 0 or unparsable = no limit. */
  limit: string
}

export type AppliedSimple = {
  filter: string
  projection: string
  sort: string
  skip: number
  /** 0 = no limit. */
  limit: number
  /** Unique across all tabs and runs; part of the result key, so Run always refetches. */
  epoch: number
}

/** Source text of an aggregation / shell run; compiled where it executes. */
export type AppliedSource = { source: string; epoch: number }

/** Last executed query of each mode; results, paging and counts derive only from these. */
export type AppliedQueries = {
  simple: AppliedSimple
  aggregation: AppliedSource | null
  shell: AppliedSource | null
}

export type CollectionTab = CollectionRef & {
  /** `t<seq>`; URI-safe, used in Monaco model URIs and tab-owned result keys. */
  id: string
  /** Stable 1-based number among open tabs of the same collection. */
  ordinal: number
  /** `seq` of the last activation; the active tab always holds the highest. */
  lastActive: number
  applied: AppliedQueries
}

type TabsState = {
  tabs: CollectionTab[]
  /** Per tab id, written together with the tab; kept apart so typing leaves `tabs` untouched. */
  drafts: Record<string, QueryDraft>
  activeTabId: string | null
  /** Monotonic source of tab ids, activation order and run epochs. */
  seq: number
  /** Focuses the most recently active tab of the collection, or opens one. */
  open: (target: CollectionRef) => void
  /** Always opens a new blank tab. */
  openNew: (target: CollectionRef) => void
  /** Shows `filter` in simple mode; never changes another tab's draft or applied query. */
  openWithFilter: (target: CollectionRef, filter: string) => void
  /** Copies the draft and the simple query into a new tab right after the source. */
  duplicate: (id: string) => void
  close: (id: string) => void
  activate: (id: string) => void
  setDraft: (id: string, patch: Partial<QueryDraft>) => void
  /**
   * Commits the draft of the visible mode with a fresh epoch; the only action that executes.
   * @returns The committed run; null for an unknown tab.
   */
  run: (id: string) => AppliedSimple | AppliedSource | null
  /** Pages the simple query; keeps its epoch so the count is reused. */
  setSkip: (id: string, skip: number) => void
  closeForConnection: (connectionId: string) => void
  closeForCollection: (connectionId: string, db: string, coll: string) => void
  closeForDatabase: (connectionId: string, db: string) => void
  renameCollection: (connectionId: string, db: string, oldName: string, newName: string) => void
}

const DEFAULT_LIMIT = 100

const DEFAULT_DRAFT: QueryDraft = {
  mode: 'simple',
  filter: '{}',
  projection: '{}',
  sort: '{}',
  pipeline: '',
  shell: '',
  limit: String(DEFAULT_LIMIT)
}

const sameCollection = (a: CollectionRef, b: CollectionRef): boolean =>
  a.connectionId === b.connectionId && a.db === b.db && a.coll === b.coll

function parseLimit(text: string): number {
  const n = Number.parseInt(text, 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

function commitSimple(draft: QueryDraft, epoch: number): AppliedSimple {
  return {
    filter: draft.filter,
    projection: draft.projection,
    sort: draft.sort,
    skip: 0,
    limit: parseLimit(draft.limit),
    epoch
  }
}

function commitDraft(applied: AppliedQueries, draft: QueryDraft, epoch: number): AppliedQueries {
  switch (draft.mode) {
    case 'simple':
      return { ...applied, simple: commitSimple(draft, epoch) }
    case 'aggregation':
      return { ...applied, aggregation: { source: draft.pipeline, epoch } }
    case 'shell':
      return { ...applied, shell: { source: draft.shell, epoch } }
  }
}

const simpleOnly =
  (draft: QueryDraft) =>
  (epoch: number): AppliedQueries => ({
    simple: commitSimple(draft, epoch),
    aggregation: null,
    shell: null
  })

function draftsEqual(a: QueryDraft, b: QueryDraft): boolean {
  return (
    a.mode === b.mode &&
    a.filter === b.filter &&
    a.projection === b.projection &&
    a.sort === b.sort &&
    a.pipeline === b.pipeline &&
    a.shell === b.shell &&
    a.limit === b.limit
  )
}

function nextOrdinal(tabs: readonly CollectionTab[], ref: CollectionRef): number {
  const used = new Set(tabs.filter((t) => sameCollection(t, ref)).map((t) => t.ordinal))
  let n = 1
  while (used.has(n)) n++
  return n
}

function mostRecent(tabs: readonly CollectionTab[]): CollectionTab | undefined {
  let best: CollectionTab | undefined
  for (const t of tabs) if (!best || t.lastActive > best.lastActive) best = t
  return best
}

function stampActive(s: TabsState, id: string): TabsState {
  if (id === s.activeTabId) return s
  const seq = s.seq + 1
  return {
    ...s,
    seq,
    activeTabId: id,
    tabs: s.tabs.map((t) => (t.id === id ? { ...t, lastActive: seq } : t))
  }
}

function addTab(
  s: TabsState,
  target: CollectionRef,
  draft: QueryDraft,
  applied: (epoch: number) => AppliedQueries,
  insertAt = s.tabs.length
): TabsState {
  // One seq supplies the id, the activation stamp and the epoch of the initial run.
  const seq = s.seq + 1
  const tab: CollectionTab = {
    id: `t${seq}`,
    connectionId: target.connectionId,
    db: target.db,
    coll: target.coll,
    ordinal: nextOrdinal(s.tabs, target),
    lastActive: seq,
    applied: applied(seq)
  }
  return {
    ...s,
    seq,
    tabs: [...s.tabs.slice(0, insertAt), tab, ...s.tabs.slice(insertAt)],
    drafts: { ...s.drafts, [tab.id]: draft },
    activeTabId: tab.id
  }
}

function removeTabs(
  s: TabsState,
  removed: (tab: CollectionTab) => boolean,
  fallback: (remaining: CollectionTab[]) => CollectionTab | undefined
): TabsState {
  const tabs = s.tabs.filter((t) => !removed(t))
  if (tabs.length === s.tabs.length) return s
  const drafts: Record<string, QueryDraft> = {}
  for (const t of tabs) {
    const draft = s.drafts[t.id]
    if (draft) drafts[t.id] = draft
  }
  const next = { ...s, tabs, drafts }
  if (tabs.some((t) => t.id === s.activeTabId)) return next
  const target = fallback(tabs)
  return target ? stampActive(next, target.id) : { ...next, activeTabId: null }
}

/** Whether the visible mode's draft differs from that mode's last run (skip and epoch ignored). */
export function isDraftDirty(draft: QueryDraft, applied: AppliedQueries): boolean {
  switch (draft.mode) {
    case 'simple':
      return (
        draft.filter !== applied.simple.filter ||
        draft.projection !== applied.simple.projection ||
        draft.sort !== applied.simple.sort ||
        parseLimit(draft.limit) !== applied.simple.limit
      )
    case 'aggregation':
      return draft.pipeline !== (applied.aggregation?.source ?? '')
    case 'shell':
      return draft.shell !== (applied.shell?.source ?? '')
  }
}

/** The tab's ordinal while another open tab shows the same collection, else null. */
export function ordinalLabel(tabs: readonly CollectionTab[], tab: CollectionTab): number | null {
  return tabs.some((t) => t.id !== tab.id && sameCollection(t, tab)) ? tab.ordinal : null
}

/** Equal for the same collection of the same connection. */
export const collectionKey = (ref: CollectionRef): string =>
  JSON.stringify([ref.connectionId, ref.db, ref.coll])

let activeKeyMemo: {
  tabs: readonly CollectionTab[]
  activeTabId: string | null
  key: string | null
} | null = null

/** Store selector: `collectionKey` of the active tab's collection; null without tabs. */
export function activeCollectionKey(s: {
  tabs: readonly CollectionTab[]
  activeTabId: string | null
}): string | null {
  // Every explorer leaf selects this on every store change, typing included; one lookup serves all.
  if (activeKeyMemo?.tabs !== s.tabs || activeKeyMemo.activeTabId !== s.activeTabId) {
    const active = s.tabs.find((t) => t.id === s.activeTabId)
    activeKeyMemo = {
      tabs: s.tabs,
      activeTabId: s.activeTabId,
      key: active ? collectionKey(active) : null
    }
  }
  return activeKeyMemo.key
}

export const useTabsStore = create<TabsState>((set, get) => ({
  tabs: [],
  drafts: {},
  activeTabId: null,
  seq: 0,
  open: (target) =>
    set((s) => {
      const existing = mostRecent(s.tabs.filter((t) => sameCollection(t, target)))
      return existing
        ? stampActive(s, existing.id)
        : addTab(s, target, DEFAULT_DRAFT, simpleOnly(DEFAULT_DRAFT))
    }),
  openNew: (target) => set((s) => addTab(s, target, DEFAULT_DRAFT, simpleOnly(DEFAULT_DRAFT))),
  openWithFilter: (target, filter) =>
    set((s) => {
      const draft: QueryDraft = { ...DEFAULT_DRAFT, filter }
      const reusable = mostRecent(
        s.tabs.filter((t) => {
          const current = s.drafts[t.id]
          return (
            sameCollection(t, target) &&
            current !== undefined &&
            draftsEqual(current, draft) &&
            !isDraftDirty(current, t.applied)
          )
        })
      )
      if (!reusable) return addTab(s, target, draft, simpleOnly(draft))
      // A repeated lookup re-runs its tab instead of piling up new ones.
      const seq = s.seq + 1
      return {
        seq,
        activeTabId: reusable.id,
        tabs: s.tabs.map((t) =>
          t.id === reusable.id
            ? { ...t, lastActive: seq, applied: { ...t.applied, simple: commitSimple(draft, seq) } }
            : t
        )
      }
    }),
  duplicate: (id) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id)
      const source = s.tabs[idx]
      const draft = s.drafts[id]
      if (!source || !draft) return s
      // Agg/shell results are keyed by tab id; copying those runs would silently re-execute them.
      return addTab(
        s,
        source,
        { ...draft },
        () => ({ simple: { ...source.applied.simple }, aggregation: null, shell: null }),
        idx + 1
      )
    }),
  close: (id) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === id)
      return removeTabs(
        s,
        (t) => t.id === id,
        (remaining) => remaining[idx] ?? remaining[idx - 1]
      )
    }),
  activate: (id) => set((s) => (s.tabs.some((t) => t.id === id) ? stampActive(s, id) : s)),
  setDraft: (id, patch) =>
    set((s) => {
      const draft = s.drafts[id]
      return draft ? { drafts: { ...s.drafts, [id]: { ...draft, ...patch } } } : s
    }),
  run: (id) => {
    const s = get()
    const draft = s.drafts[id]
    const tab = s.tabs.find((t) => t.id === id)
    if (!draft || !tab) return null
    const seq = s.seq + 1
    const applied = commitDraft(tab.applied, draft, seq)
    set({ seq, tabs: s.tabs.map((t) => (t.id === id ? { ...t, applied } : t)) })
    return applied[draft.mode]
  },
  setSkip: (id, skip) =>
    set((s) => {
      if (!s.tabs.some((t) => t.id === id)) return s
      return {
        tabs: s.tabs.map((t) =>
          t.id === id
            ? { ...t, applied: { ...t.applied, simple: { ...t.applied.simple, skip } } }
            : t
        )
      }
    }),
  closeForConnection: (connectionId) =>
    set((s) =>
      removeTabs(
        s,
        (t) => t.connectionId === connectionId,
        (remaining) => remaining[0]
      )
    ),
  closeForCollection: (connectionId, db, coll) =>
    set((s) =>
      removeTabs(
        s,
        (t) => sameCollection(t, { connectionId, db, coll }),
        (remaining) => remaining[0]
      )
    ),
  closeForDatabase: (connectionId, db) =>
    set((s) =>
      removeTabs(
        s,
        (t) => t.connectionId === connectionId && t.db === db,
        (remaining) => remaining[0]
      )
    ),
  renameCollection: (connectionId, db, oldName, newName) =>
    set((s) => {
      const from = { connectionId, db, coll: oldName }
      const to = { connectionId, db, coll: newName }
      if (!s.tabs.some((t) => sameCollection(t, from))) return s
      // The kept result writes to the old name and a new-name key would re-run it: wait for Run.
      const moved = (t: CollectionTab): CollectionTab => ({
        ...t,
        coll: newName,
        applied: { ...t.applied, aggregation: null }
      })
      // Numbers held by stale tabs of the new name; only renamed tabs that collide renumber.
      const taken = new Set(
        s.tabs
          .filter((t) => sameCollection(t, to) && !sameCollection(t, from))
          .map((t) => t.ordinal)
      )
      let tabs = s.tabs.map((t) =>
        sameCollection(t, from) && !taken.has(t.ordinal) ? moved(t) : t
      )
      for (const t of s.tabs) {
        if (!sameCollection(t, from) || !taken.has(t.ordinal)) continue
        const renamed = { ...moved(t), ordinal: nextOrdinal(tabs, to) }
        tabs = tabs.map((x) => (x.id === t.id ? renamed : x))
      }
      return { tabs }
    })
}))
