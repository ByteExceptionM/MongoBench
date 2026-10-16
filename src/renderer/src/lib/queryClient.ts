import {
  QueryClient,
  skipToken,
  type MutationOptions,
  type QueryKey,
  type UseQueryOptions
} from '@tanstack/react-query'
import type { ErrorCode } from '@shared/result'
import type { CollectionRef, DatabaseRef } from '@shared/types'
import { useAppStore } from '@/store'
import { useTabsStore, type AppliedSource, type QueryMode } from '@/store/tabs'
import { ApiError } from './api'
import { cancelRequests, withRequestId } from './queryCancellation'
import {
  runShellWrite,
  writtenCollection,
  type ShellWriteCommand,
  type ShellWriteResult
} from './queryRun'

/** Retrying these cannot change the answer — the input has to change first. */
const NEVER_RETRIED = new Set<ErrorCode>([
  'validation_error',
  'auth_failed',
  'ssh_auth_failed',
  'ssh_host_key_mismatch',
  'cloudflared_not_found',
  'cloudflared_auth_failed',
  'cancelled',
  // The driver itself retries the server errors that a repeat can fix.
  'driver_error'
])

// Requests reach main over IPC, so the OS reporting no network must not pause them.
const networkMode = 'always'

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error) => {
        if (error instanceof ApiError && NEVER_RETRIED.has(error.code)) return false
        return failureCount < 1
      },
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      networkMode
    },
    mutations: {
      retry: false,
      networkMode
    }
  }
})

export const queryKeys = {
  connections: ['connections'] as const,
  databases: (connectionId: string) => ['databases', connectionId] as const,
  collections: (connectionId: string, db: string) => ['collections', connectionId, db] as const,
  collectionStats: (connectionId: string, db: string, coll: string) =>
    ['collection-stats', connectionId, db, coll] as const,
  indexes: (connectionId: string, db: string, coll: string) =>
    ['indexes', connectionId, db, coll] as const,
  // Nested under indexes() so every invalidation of the list also refreshes the stats.
  indexStats: (connectionId: string, db: string, coll: string) =>
    ['indexes', connectionId, db, coll, 'stats'] as const,
  collectionSchema: (connectionId: string, db: string, coll: string) =>
    ['collection-schema', connectionId, db, coll] as const,
  users: (connectionId: string, db: string) => ['users', connectionId, db] as const,
  roles: (connectionId: string, db: string) => ['roles', connectionId, db] as const,
  cloudflaredVersion: (binaryPath: string) => ['cloudflared-version', binaryPath] as const,
  serverStats: (connectionId: string) => ['server-stats', connectionId] as const,
  find: (
    connectionId: string,
    db: string,
    coll: string,
    filter: string,
    projection: string,
    sort: string,
    skip: number,
    limit: number,
    epoch: number
  ) => ['find', connectionId, db, coll, { filter, projection, sort, skip, limit, epoch }] as const,
  // Aggregation and shell results belong to one tab, so closing it can drop them.
  aggregate: (
    tabId: string,
    connectionId: string,
    db: string,
    coll: string,
    pipeline: string,
    epoch: number
  ) => ['aggregate', tabId, connectionId, db, coll, { pipeline, epoch }] as const,
  shell: (tabId: string, connectionId: string, db: string, command: string, epoch: number) =>
    ['shell', tabId, connectionId, db, { command, epoch }] as const,
  count: (connectionId: string, db: string, coll: string, filter: string, epoch: number) =>
    ['count', connectionId, db, coll, { filter, epoch }] as const
}

export const mutationKeys = {
  shellWrite: ['shell-write'] as const
}

/** One shell write: what it executes, and the tab and applied shell run (epoch) it belongs to. */
export type ShellWriteVariables = {
  tabId: string
  epoch: number
  target: DatabaseRef
  command: ShellWriteCommand
}

/** Simple find / count: re-run only by Run, paging or a write; released with their epoch. */
export const simpleRunOptions = {
  refetchOnMount: false,
  staleTime: Infinity,
  gcTime: Infinity
} as const

/** Explicitly run results: kept until replaced or closed, re-run only by Run or a write. */
export const explicitRunOptions = {
  gcTime: Infinity,
  staleTime: Infinity,
  retry: false,
  retryOnMount: false,
  refetchOnMount: false,
  refetchOnReconnect: false
} as const

/** A run's result key and its execution under a request id that `query.cancel` can abort. */
export type RunnableQuery<T> = { key: QueryKey; execute: (requestId: string) => Promise<T> }

/**
 * Options of a tab's result query for `run`; without one it observes an idle placeholder.
 * @param executes false keeps a hidden mode's result observed without ever executing it
 */
export function runQueryOptions<T>(
  tabId: string,
  run: RunnableQuery<T> | null,
  policy: typeof simpleRunOptions | typeof explicitRunOptions,
  executes = true
): UseQueryOptions<T, Error, T, QueryKey> {
  if (run === null) return { queryKey: ['idle', tabId], queryFn: skipToken }
  return {
    queryKey: run.key,
    queryFn: () => withRequestId(run.key, run.execute),
    // A result without data counts as stale, so showing a failed or cancelled run's key again (tab or
    // mode switch) would re-execute it; it stays failed until Run creates a new key.
    enabled: (query) => executes && query.state.status !== 'error',
    ...policy
  }
}

type KeyFamily = {
  /** Index of the connectionId; db and coll follow for `depth` levels. */
  at: number
  depth: number
  /** Mode whose runs fill it: Simple results are shared by epoch, the others belong to one tab. */
  run?: QueryMode
}

// Shell keys stop at the database: a command may read any of its collections. Aggregation and
// shell keys hold their tab id right before the connectionId.
const KEY_FAMILIES = new Map<string, KeyFamily>([
  ['databases', { at: 1, depth: 1 }],
  ['collections', { at: 1, depth: 2 }],
  ['users', { at: 1, depth: 2 }],
  ['roles', { at: 1, depth: 2 }],
  ['collection-stats', { at: 1, depth: 3 }],
  ['indexes', { at: 1, depth: 3 }],
  ['collection-schema', { at: 1, depth: 3 }],
  ['find', { at: 1, depth: 3, run: 'simple' }],
  ['count', { at: 1, depth: 3, run: 'simple' }],
  ['aggregate', { at: 2, depth: 3, run: 'aggregation' }],
  ['shell', { at: 2, depth: 2, run: 'shell' }]
])

function familyOf(key: QueryKey): KeyFamily | undefined {
  const name = key[0]
  return typeof name === 'string' ? KEY_FAMILIES.get(name) : undefined
}

const keyWithin = (key: QueryKey, at: number, scope: readonly string[]): boolean =>
  scope.every((part, i) => key[at + i] === part)

const isTabRun = (run: QueryMode | undefined): boolean => run === 'aggregation' || run === 'shell'

function tabOf(key: QueryKey): unknown {
  const family = familyOf(key)
  return family && isTabRun(family.run) ? key[family.at - 1] : undefined
}

// Every run key ends with its options object, which carries the epoch.
const epochOf = (key: QueryKey): unknown => (key[key.length - 1] as { epoch?: unknown }).epoch

/**
 * Removes the cached queries of a dropped, renamed or disconnected namespace.
 * @param db Omit to cover the whole connection.
 * @param coll Omit to cover the whole database.
 */
export function removeNamespaceQueries(
  qc: QueryClient,
  connectionId: string,
  db?: string,
  coll?: string
): void {
  const scope =
    db === undefined
      ? [connectionId]
      : coll === undefined
        ? [connectionId, db]
        : [connectionId, db, coll]
  qc.removeQueries({
    predicate: ({ queryKey }) => {
      const family = familyOf(queryKey)
      // Coarser families stay: removing a mounted shell result would re-run it.
      return (
        family !== undefined &&
        family.depth >= scope.length &&
        keyWithin(queryKey, family.at, scope)
      )
    }
  })
}

/**
 * Refreshes what a write to the collection may have changed; call it after every write.
 * @returns Settles once the shown results that may read the collection have refetched.
 */
export function invalidateWrittenCollection(
  qc: QueryClient,
  { connectionId, db, coll }: CollectionRef
): Promise<void> {
  const scope = [connectionId, db, coll]
  const readingRun = (key: QueryKey): QueryMode | undefined => {
    const family = familyOf(key)
    return family && keyWithin(key, family.at, scope.slice(0, family.depth))
      ? family.run
      : undefined
  }
  return Promise.all([
    qc.invalidateQueries({ predicate: ({ queryKey }) => readingRun(queryKey) === 'simple' }),
    // A hidden aggregation or shell result marked stale would re-run on its next tab or mode switch.
    qc.refetchQueries({
      type: 'active',
      predicate: ({ queryKey }) => isTabRun(readingRun(queryKey))
    }),
    // An insert or $out may have created the collection.
    qc.invalidateQueries({ queryKey: queryKeys.collections(connectionId, db) }),
    qc.invalidateQueries({ queryKey: queryKeys.collectionStats(connectionId, db, coll) })
  ]).then(() => undefined)
}

/**
 * Options of the shell write mutation: each `mutate` runs its write once; no query can re-run it.
 * @param qc Refreshed after every write, failed ones included.
 */
export function shellWriteOptions(
  qc: QueryClient
): MutationOptions<ShellWriteResult, Error, ShellWriteVariables> {
  return {
    mutationKey: mutationKeys.shellWrite,
    mutationFn: ({ target, command }) => runShellWrite(target, command),
    // A failed ordered insertMany or bulkWrite may have written its first documents.
    onSettled: (_result, _error, { target, command }) => {
      void invalidateWrittenCollection(qc, writtenCollection(target, command))
    },
    // Shown until its tab closes or a newer shell run replaces it.
    gcTime: Infinity
  }
}

function releaseRuns(matches: (key: QueryKey) => boolean): void {
  cancelRequests(matches)
  queryClient.removeQueries({ predicate: (query) => matches(query.queryKey) })
}

// A write still running finishes on the server; only its result is dropped.
function releaseWrites(matches: (run: ShellWriteVariables) => boolean): void {
  const cache = queryClient.getMutationCache()
  for (const mutation of cache.findAll({ mutationKey: mutationKeys.shellWrite })) {
    const run = mutation.state.variables as ShellWriteVariables | undefined
    if (run && matches(run)) cache.remove(mutation)
  }
}

/** Drops a closed tab's aggregation / shell results and shell writes; aborts its running reads. */
export function releaseTabResults(tabId: string): void {
  releaseRuns((key) => tabOf(key) === tabId)
  releaseWrites((run) => run.tabId === tabId)
}

/** Forgets a disconnected or deleted connection: its connected state, tabs and cached queries. */
export function releaseConnection(qc: QueryClient, connectionId: string): void {
  useAppStore.getState().markDisconnected(connectionId)
  useTabsStore.getState().closeForConnection(connectionId)
  removeNamespaceQueries(qc, connectionId)
}

function releaseSuperseded(
  mode: 'aggregation' | 'shell',
  tabId: string,
  current: AppliedSource | null
): void {
  releaseRuns(
    (key) => familyOf(key)?.run === mode && tabOf(key) === tabId && epochOf(key) !== current?.epoch
  )
}

// Every close, Run, lookup and rename ends up here; a run no open tab can show again is released.
useTabsStore.subscribe((state, prev) => {
  if (state.tabs === prev.tabs) return
  const open = new Map(state.tabs.map((t) => [t.id, t.applied]))
  // Duplicates share a simple epoch, so its pages and count stay while any tab holds it.
  const heldEpochs = new Set(state.tabs.map((t) => t.applied.simple.epoch))
  for (const { id, applied } of prev.tabs) {
    const next = open.get(id)
    if (!next) {
      releaseTabResults(id)
    } else {
      if (next.aggregation !== applied.aggregation) {
        releaseSuperseded('aggregation', id, next.aggregation)
      }
      if (next.shell !== applied.shell) {
        releaseSuperseded('shell', id, next.shell)
        releaseWrites((run) => run.tabId === id && run.epoch !== next.shell?.epoch)
      }
    }
    const { epoch } = applied.simple
    if (!heldEpochs.has(epoch)) {
      releaseRuns((key) => familyOf(key)?.run === 'simple' && epochOf(key) === epoch)
    }
  }
})
