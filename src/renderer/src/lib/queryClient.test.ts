import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  hashKey,
  MutationObserver,
  onlineManager,
  QueryClient,
  QueryObserver,
  type QueryKey
} from '@tanstack/react-query'
import type { CollectionRef, WriteResponse } from '@shared/types'
import { useAppStore } from '@/store'
import { useTabsStore } from '@/store/tabs'
import { api, ApiError } from './api'
import {
  explicitRunOptions,
  invalidateWrittenCollection,
  mutationKeys,
  queryClient,
  queryKeys,
  releaseConnection,
  releaseTabResults,
  removeNamespaceQueries,
  runQueryOptions,
  shellWriteOptions,
  simpleRunOptions,
  type ShellWriteVariables
} from './queryClient'
import { cancelRequests, withRequestId } from './queryCancellation'
import type { ShellWriteCommand, ShellWriteResult } from './queryRun'

const cancel = vi.spyOn(api.query, 'cancel').mockResolvedValue(undefined)
const write = vi.spyOn(api.query, 'write')

const WRITTEN: WriteResponse = { tookMs: 4, counts: { deleted: 3 }, ids: [], idsTruncated: false }

/** Every key family scoped to `connectionId/db/coll`, as the app builds them. */
function namespaceKeys(c: string, db: string, coll: string, tabId: string): QueryKey[] {
  return [
    queryKeys.databases(c),
    queryKeys.collections(c, db),
    queryKeys.users(c, db),
    queryKeys.roles(c, db),
    queryKeys.collectionStats(c, db, coll),
    queryKeys.indexes(c, db, coll),
    queryKeys.indexStats(c, db, coll),
    queryKeys.collectionSchema(c, db, coll),
    queryKeys.find(c, db, coll, '{}', '{}', '{}', 0, 100, 1),
    queryKeys.count(c, db, coll, '{}', 1),
    queryKeys.aggregate(tabId, c, db, coll, '[]', 2),
    queryKeys.shell(tabId, c, db, `db.${coll}.find()`, 3)
  ]
}

const UNSCOPED: QueryKey[] = [
  queryKeys.connections,
  queryKeys.serverStats('c1'),
  queryKeys.cloudflaredVersion('c1')
]

function populated(): QueryClient {
  const qc = new QueryClient()
  const keys = [
    ...namespaceKeys('c1', 'app', 'users', 't1'),
    ...namespaceKeys('c1', 'app', 'orders', 't2'),
    ...namespaceKeys('c1', 'audit', 'users', 't3'),
    ...namespaceKeys('c2', 'app', 'users', 't4'),
    ...UNSCOPED
  ]
  for (const key of keys) qc.setQueryData(key, 'cached')
  return qc
}

const cachedKeys = (qc: QueryClient): string[] =>
  qc
    .getQueryCache()
    .getAll()
    .map((q) => q.queryHash)
    .sort()
const hashes = (keys: QueryKey[]): string[] => [...new Set(keys.map(hashKey))].sort()

const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

/** One persistent observer whose key follows mode and tab switches, as in CollectionTab. */
function resultView(qc: QueryClient, initial: QueryKey) {
  const runs = new Map<string, number>()
  // `['idle', tabId]` shows no run, like a mode that never ran.
  const options = (queryKey: QueryKey) =>
    runQueryOptions(
      String(queryKey[1]),
      queryKey[0] === 'idle'
        ? null
        : {
            key: queryKey,
            execute: async () => {
              runs.set(hashKey(queryKey), (runs.get(hashKey(queryKey)) ?? 0) + 1)
              return 'rows'
            }
          },
      explicitRunOptions
    )
  const observer = new QueryObserver(qc, options(initial))
  const unsubscribe = observer.subscribe(() => undefined)
  return {
    show: (queryKey: QueryKey) => observer.setOptions(options(queryKey)),
    runs: (queryKey: QueryKey) => runs.get(hashKey(queryKey)) ?? 0,
    unsubscribe
  }
}

/** Starts a server op that stays open until released; its request id is known at once. */
function runningOp(queryKey: QueryKey): { requestId: string; release: () => Promise<void> } {
  let requestId = ''
  let finish!: () => void
  const done = withRequestId(queryKey, (id) => {
    requestId = id
    return new Promise<void>((resolve) => (finish = resolve))
  })
  return {
    requestId,
    release: () => {
      finish()
      return done
    }
  }
}

const tabOf = (id: string) => {
  const found = useTabsStore.getState().tabs.find((t) => t.id === id)
  if (!found) throw new Error(`no tab ${id}`)
  return found
}
const activeId = (): string => useTabsStore.getState().activeTabId ?? ''

/** Find (current page) and count keys of the tab's applied simple run. */
function simpleKeys(id: string): [QueryKey, QueryKey] {
  const { connectionId, db, coll, applied } = tabOf(id)
  const s = applied.simple
  return [
    queryKeys.find(
      connectionId,
      db,
      coll,
      s.filter,
      s.projection,
      s.sort,
      s.skip,
      s.limit,
      s.epoch
    ),
    queryKeys.count(connectionId, db, coll, s.filter, s.epoch)
  ]
}

function aggregateKey(id: string): QueryKey {
  const { connectionId, db, coll, applied } = tabOf(id)
  if (!applied.aggregation) throw new Error(`no aggregation run in ${id}`)
  const { source, epoch } = applied.aggregation
  return queryKeys.aggregate(id, connectionId, db, coll, source, epoch)
}

function shellKey(id: string): QueryKey {
  const { connectionId, db, applied } = tabOf(id)
  if (!applied.shell) throw new Error(`no shell run in ${id}`)
  return queryKeys.shell(id, connectionId, db, applied.shell.source, applied.shell.epoch)
}

const deleteAll = (coll: string): ShellWriteCommand => ({
  coll,
  op: { kind: 'write', write: { method: 'deleteMany', filter: '{}' }, writes: { db: null, coll } }
})

/** Commits the tab's shell draft and runs it as a write under that run's epoch, as Run does. */
function runWrite(
  writer: MutationObserver<ShellWriteResult, Error, ShellWriteVariables>,
  tabId: string,
  command: ShellWriteCommand = deleteAll(tabOf(tabId).coll)
): Promise<unknown> {
  useTabsStore.getState().run(tabId)
  const { connectionId, db, applied } = tabOf(tabId)
  if (!applied.shell) throw new Error(`no shell run in ${tabId}`)
  return writer.mutate({ tabId, epoch: applied.shell.epoch, target: { connectionId, db }, command })
}

const writeRuns = (): ShellWriteVariables[] =>
  queryClient
    .getMutationCache()
    .findAll({ mutationKey: mutationKeys.shellWrite })
    .map((m) => m.state.variables as ShellWriteVariables)

beforeEach(() => {
  // Epochs restart with the store, so a request left running would collide with the next test's.
  cancelRequests(() => true)
  cancel.mockClear()
  write.mockReset().mockResolvedValue(WRITTEN)
  queryClient.clear()
  useTabsStore.setState(useTabsStore.getInitialState(), true)
})

describe('removeNamespaceQueries', () => {
  it('collection scope removes that collection, keeping database-wide families and other namespaces', () => {
    const qc = populated()
    const before = cachedKeys(qc)
    removeNamespaceQueries(qc, 'c1', 'app', 'users')
    const after = new Set(cachedKeys(qc))
    expect(before.filter((h) => !after.has(h))).toEqual(
      hashes([
        queryKeys.collectionStats('c1', 'app', 'users'),
        queryKeys.indexes('c1', 'app', 'users'),
        queryKeys.indexStats('c1', 'app', 'users'),
        queryKeys.collectionSchema('c1', 'app', 'users'),
        queryKeys.find('c1', 'app', 'users', '{}', '{}', '{}', 0, 100, 1),
        queryKeys.count('c1', 'app', 'users', '{}', 1),
        queryKeys.aggregate('t1', 'c1', 'app', 'users', '[]', 2)
      ])
    )
  })

  it('database scope removes everything of the database, including lists, users and shell results', () => {
    const qc = populated()
    removeNamespaceQueries(qc, 'c1', 'app')
    expect(cachedKeys(qc)).toEqual(
      hashes([
        ...namespaceKeys('c1', 'audit', 'users', 't3'),
        ...namespaceKeys('c2', 'app', 'users', 't4'),
        ...UNSCOPED
      ])
    )
  })

  it('connection scope removes everything of that connection and nothing else', () => {
    const qc = populated()
    removeNamespaceQueries(qc, 'c1')
    expect(cachedKeys(qc)).toEqual(
      hashes([...namespaceKeys('c2', 'app', 'users', 't4'), ...UNSCOPED])
    )
  })
})

describe('invalidateWrittenCollection', () => {
  const users: CollectionRef = { connectionId: 'c1', db: 'app', coll: 'users' }

  it("marks the collection's find, count and stats and its database's collection list stale, nothing else", async () => {
    const qc = populated()
    await invalidateWrittenCollection(qc, users)
    const invalidated = qc
      .getQueryCache()
      .getAll()
      .filter((q) => q.state.isInvalidated)
      .map((q) => q.queryHash)
      .sort()
    expect(invalidated).toEqual(
      hashes([
        queryKeys.find('c1', 'app', 'users', '{}', '{}', '{}', 0, 100, 1),
        queryKeys.count('c1', 'app', 'users', '{}', 1),
        queryKeys.collections('c1', 'app'),
        queryKeys.collectionStats('c1', 'app', 'users')
      ])
    )
  })

  it('re-runs the shown aggregation and shell results that may read the collection', async () => {
    const qc = new QueryClient()
    const pipeline = queryKeys.aggregate('t1', 'c1', 'app', 'users', '[]', 2)
    // Shell keys name only the database: any command there may read the collection.
    const command = queryKeys.shell('t2', 'c1', 'app', 'db.orders.find()', 3)
    const otherCollection = queryKeys.aggregate('t3', 'c1', 'app', 'orders', '[]', 4)
    const views = [pipeline, command, otherCollection].map((key) => resultView(qc, key))
    await settle()
    await invalidateWrittenCollection(qc, users)
    expect(views.map((view, i) => view.runs([pipeline, command, otherCollection][i]!))).toEqual([
      2, 2, 1
    ])
    views.forEach((view) => view.unsubscribe())
  })

  it('never re-runs a hidden aggregation when a mode switch shows it again', async () => {
    const qc = new QueryClient()
    const pipeline = queryKeys.aggregate('t1', 'c1', 'app', 'users', '[]', 2)
    const view = resultView(qc, pipeline)
    await settle()
    view.show(['idle', 't1'])
    await invalidateWrittenCollection(qc, users)
    view.show(pipeline)
    await settle()
    expect(view.runs(pipeline)).toBe(1)
    expect(qc.getQueryData(pipeline)).toBe('rows')
    view.unsubscribe()
  })

  it('never re-runs a hidden shell result when a tab switch shows it again', async () => {
    const qc = new QueryClient()
    const command = queryKeys.shell('t1', 'c1', 'app', 'db.big.find()', 2)
    const view = resultView(qc, command)
    await settle()
    view.show(['idle', 't2'])
    await invalidateWrittenCollection(qc, { ...users, coll: 'small' })
    view.show(command)
    await settle()
    expect(view.runs(command)).toBe(1)
    view.unsubscribe()
  })
})

describe('runQueryOptions', () => {
  const key = queryKeys.find('c1', 'app', 'users', '{}', '{}', '{}', 0, 100, 1)
  const noRetry = () => new QueryClient({ defaultOptions: { queries: { retry: false } } })

  it("observes the tab's idle placeholder without a run", async () => {
    const qc = noRetry()
    const observer = new QueryObserver(qc, runQueryOptions('t1', null, simpleRunOptions))
    const unsubscribe = observer.subscribe(() => undefined)
    await settle()
    expect(
      qc
        .getQueryCache()
        .getAll()
        .map((q) => q.queryKey)
    ).toEqual([['idle', 't1']])
    expect(observer.getCurrentResult()).toMatchObject({ fetchStatus: 'idle', data: undefined })
    unsubscribe()
  })

  it('never executes a failed run again when it is shown again', async () => {
    const qc = noRetry()
    const execute = vi.fn().mockRejectedValue(new Error('$where is not allowed'))
    const shown = runQueryOptions('t1', { key, execute }, simpleRunOptions)
    const observer = new QueryObserver(qc, shown)
    const unsubscribe = observer.subscribe(() => undefined)
    await settle()
    observer.setOptions(runQueryOptions('t1', null, simpleRunOptions))
    observer.setOptions(shown)
    await settle()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(observer.getCurrentResult().error?.message).toBe('$where is not allowed')
    unsubscribe()
  })

  it('executes a hidden run only once it is shown', async () => {
    const qc = noRetry()
    const execute = vi.fn().mockResolvedValue('rows')
    const observer = new QueryObserver(
      qc,
      runQueryOptions('t1', { key, execute }, simpleRunOptions, false)
    )
    const unsubscribe = observer.subscribe(() => undefined)
    await settle()
    expect(execute).not.toHaveBeenCalled()
    observer.setOptions(runQueryOptions('t1', { key, execute }, simpleRunOptions))
    await settle()
    expect(execute).toHaveBeenCalledTimes(1)
    expect(observer.getCurrentResult().data).toBe('rows')
    unsubscribe()
  })
})

describe('releaseConnection', () => {
  it('marks the connection disconnected, closes its tabs and drops its queries', () => {
    useAppStore.setState(useAppStore.getInitialState(), true)
    for (const id of ['c1', 'c2']) {
      useAppStore.getState().markConnected(id)
      useTabsStore.getState().openNew({ connectionId: id, db: 'app', coll: 'users' })
      queryClient.setQueryData(queryKeys.databases(id), 'cached')
    }
    releaseConnection(queryClient, 'c1')
    expect([...useAppStore.getState().activeConnectionIds]).toEqual(['c2'])
    expect(useTabsStore.getState().tabs.map((t) => t.connectionId)).toEqual(['c2'])
    expect(queryClient.getQueryData(queryKeys.databases('c1'))).toBeUndefined()
    expect(queryClient.getQueryData(queryKeys.databases('c2'))).toBe('cached')
  })
})

describe('retry', () => {
  const retry = queryClient.getDefaultOptions().queries?.retry as (
    failureCount: number,
    error: Error
  ) => boolean

  it('does not repeat a server error; the driver already retried what can succeed', () => {
    const error = new ApiError({ code: 'driver_error', message: '$where is not allowed' })
    expect(retry(0, error)).toBe(false)
  })

  it('repeats a network failure once', () => {
    const error = new ApiError({ code: 'network_error', message: 'connection reset' })
    expect(retry(0, error)).toBe(true)
    expect(retry(1, error)).toBe(false)
  })
})

describe('while the OS reports no network', () => {
  afterEach(() => onlineManager.setOnline(true))

  it('runs queries, which reach main over IPC', async () => {
    onlineManager.setOnline(false)
    const observer = new QueryObserver(queryClient, {
      queryKey: queryKeys.connections,
      queryFn: async () => 'rows'
    })
    const unsubscribe = observer.subscribe(() => undefined)
    await settle()
    expect(observer.getCurrentResult()).toMatchObject({ status: 'success', data: 'rows' })
    unsubscribe()
  })

  it('runs a shell write when Run is pressed and not again once the network returns', async () => {
    onlineManager.setOnline(false)
    const writer = new MutationObserver(queryClient, shellWriteOptions(queryClient))
    const running = writer.mutate({
      tabId: 't1',
      epoch: 1,
      target: { connectionId: 'c1', db: 'app' },
      command: deleteAll('users')
    })
    await settle()
    expect(write).toHaveBeenCalledTimes(1)
    await running
    onlineManager.setOnline(true)
    await settle()
    expect(write).toHaveBeenCalledTimes(1)
  })
})

describe('releaseTabResults', () => {
  it("drops the tab's aggregation and shell results only", () => {
    const own = [
      queryKeys.aggregate('t1', 'c1', 'app', 'users', '[]', 2),
      queryKeys.shell('t1', 'c1', 'app', 'db.users.find()', 3)
    ]
    const kept = [
      queryKeys.aggregate('t11', 'c1', 'app', 'users', '[]', 4),
      queryKeys.shell('t2', 'c1', 'app', 'db.users.find()', 5),
      queryKeys.find('c1', 'app', 'users', '{}', '{}', '{}', 0, 100, 1)
    ]
    for (const key of [...own, ...kept]) queryClient.setQueryData(key, 'cached')
    releaseTabResults('t1')
    for (const key of own) expect(queryClient.getQueryData(key)).toBeUndefined()
    for (const key of kept) expect(queryClient.getQueryData(key)).toBe('cached')
  })

  it("aborts the tab's running server ops", async () => {
    let resolveOwn!: () => void
    let resolveOther!: () => void
    let ownId = ''
    const own = withRequestId(queryKeys.aggregate('t1', 'c1', 'app', 'users', '[]', 2), (id) => {
      ownId = id
      return new Promise<void>((resolve) => (resolveOwn = resolve))
    })
    const other = withRequestId(
      queryKeys.aggregate('t2', 'c1', 'app', 'users', '[]', 3),
      () => new Promise<void>((resolve) => (resolveOther = resolve))
    )
    releaseTabResults('t1')
    expect(cancel.mock.calls).toEqual([[{ requestId: ownId }]])
    resolveOwn()
    resolveOther()
    await Promise.all([own, other])
  })
})

describe('closing tabs', () => {
  const users = { connectionId: 'c1', db: 'app', coll: 'users' }

  it('releases the results of every tab that closes, whichever action closed it', () => {
    const tabs = useTabsStore.getState()
    tabs.openNew(users)
    const a = useTabsStore.getState().activeTabId ?? ''
    tabs.openNew(users)
    const b = useTabsStore.getState().activeTabId ?? ''
    tabs.openNew({ ...users, connectionId: 'c2' })
    const c = useTabsStore.getState().activeTabId ?? ''
    const keyOf = (tabId: string) => queryKeys.shell(tabId, 'c1', 'app', 'db.users.find()', 1)
    for (const id of [a, b, c]) queryClient.setQueryData(keyOf(id), 'cached')

    useTabsStore.getState().close(a)
    expect(queryClient.getQueryData(keyOf(a))).toBeUndefined()
    expect(queryClient.getQueryData(keyOf(b))).toBe('cached')

    useTabsStore.getState().closeForConnection('c1')
    expect(queryClient.getQueryData(keyOf(b))).toBeUndefined()
    expect(queryClient.getQueryData(keyOf(c))).toBe('cached')
  })

  it('keeps the shown runs while tabs are paged, opened or activated', () => {
    const tabs = useTabsStore.getState()
    tabs.openNew(users)
    const a = activeId()
    tabs.setDraft(a, { mode: 'aggregation', pipeline: '[]' })
    tabs.run(a)
    tabs.setDraft(a, { mode: 'shell', shell: 'db.users.find()' })
    tabs.run(a)
    const keys = [...simpleKeys(a), aggregateKey(a), shellKey(a)]
    for (const key of keys) queryClient.setQueryData(key, 'cached')
    tabs.setSkip(a, 100)
    tabs.openNew(users)
    tabs.activate(a)
    for (const key of keys) expect(queryClient.getQueryData(key)).toBe('cached')
    expect(cancel).not.toHaveBeenCalled()
  })

  it("drops a closed tab's find and count and aborts their running server ops", async () => {
    useTabsStore.getState().openNew(users)
    const a = activeId()
    const [find, count] = simpleKeys(a)
    queryClient.setQueryData(find, 'cached')
    const op = runningOp(count)
    useTabsStore.getState().close(a)
    expect(queryClient.getQueryData(find)).toBeUndefined()
    expect(cancel.mock.calls).toEqual([[{ requestId: op.requestId }]])
    await op.release()
  })

  it('keeps find and count while a duplicate still shows the same run', async () => {
    useTabsStore.getState().openNew(users)
    const a = activeId()
    useTabsStore.getState().duplicate(a)
    const b = activeId()
    const [find, count] = simpleKeys(a)
    queryClient.setQueryData(find, 'cached')
    const op = runningOp(count)
    useTabsStore.getState().close(a)
    expect(queryClient.getQueryData(find)).toBe('cached')
    expect(cancel).not.toHaveBeenCalled()
    useTabsStore.getState().close(b)
    expect(queryClient.getQueryData(find)).toBeUndefined()
    expect(cancel.mock.calls).toEqual([[{ requestId: op.requestId }]])
    await op.release()
  })
})

describe('replacing a run', () => {
  const users = { connectionId: 'c1', db: 'app', coll: 'users' }

  it('Run drops every page and the count of the replaced simple run and aborts them', async () => {
    useTabsStore.getState().openNew(users)
    const a = activeId()
    const [firstPage, count] = simpleKeys(a)
    useTabsStore.getState().setSkip(a, 100)
    const [secondPage] = simpleKeys(a)
    queryClient.setQueryData(firstPage, 'cached')
    queryClient.setQueryData(count, 'cached')
    const op = runningOp(secondPage)
    useTabsStore.getState().run(a)
    for (const key of [firstPage, secondPage, count]) {
      expect(queryClient.getQueryData(key)).toBeUndefined()
    }
    expect(cancel.mock.calls).toEqual([[{ requestId: op.requestId }]])
    await op.release()
  })

  it('a repeated lookup drops the run its tab showed before', () => {
    const lookup = '{ _id: 1 }'
    useTabsStore.getState().openWithFilter(users, lookup)
    const a = activeId()
    const [find] = simpleKeys(a)
    queryClient.setQueryData(find, 'cached')
    useTabsStore.getState().openNew({ ...users, coll: 'orders' })
    useTabsStore.getState().openWithFilter(users, lookup)
    expect(activeId()).toBe(a)
    expect(queryClient.getQueryData(find)).toBeUndefined()
  })

  it.each([
    ['aggregation', { pipeline: '[]' }, aggregateKey],
    ['shell', { shell: 'db.users.find()' }, shellKey]
  ] as const)(
    "Run drops the tab's superseded %s run and aborts it, keeping other tabs' runs",
    async (mode, draft, keyOf) => {
      useTabsStore.getState().openNew(users)
      const other = activeId()
      useTabsStore.getState().setDraft(other, { mode, ...draft })
      useTabsStore.getState().run(other)
      queryClient.setQueryData(keyOf(other), 'cached')
      useTabsStore.getState().openNew(users)
      const a = activeId()
      useTabsStore.getState().setDraft(a, { mode, ...draft })
      useTabsStore.getState().run(a)
      const superseded = keyOf(a)
      const op = runningOp(superseded)
      useTabsStore.getState().run(a)
      queryClient.setQueryData(keyOf(a), 'cached')
      expect(queryClient.getQueryData(superseded)).toBeUndefined()
      expect(queryClient.getQueryData(keyOf(a))).toBe('cached')
      expect(queryClient.getQueryData(keyOf(other))).toBe('cached')
      expect(cancel.mock.calls).toEqual([[{ requestId: op.requestId }]])
      await op.release()
    }
  )

  it("rename drops the tab's aggregation run and keeps its shell run", () => {
    useTabsStore.getState().openNew(users)
    const a = activeId()
    useTabsStore.getState().setDraft(a, { mode: 'aggregation', pipeline: '[]' })
    useTabsStore.getState().run(a)
    useTabsStore.getState().setDraft(a, { mode: 'shell', shell: 'db.users.find()' })
    useTabsStore.getState().run(a)
    const pipeline = aggregateKey(a)
    const command = shellKey(a)
    queryClient.setQueryData(pipeline, 'cached')
    queryClient.setQueryData(command, 'cached')
    useTabsStore.getState().renameCollection('c1', 'app', 'users', 'members')
    expect(queryClient.getQueryData(pipeline)).toBeUndefined()
    expect(queryClient.getQueryData(command)).toBe('cached')
  })
})

describe('shell writes', () => {
  const users = { connectionId: 'c1', db: 'app', coll: 'users' }
  const writer = () => new MutationObserver(queryClient, shellWriteOptions(queryClient))

  function openShellTab(ref = users): string {
    useTabsStore.getState().openNew(ref)
    const id = activeId()
    useTabsStore.getState().setDraft(id, { mode: 'shell', shell: `db.${ref.coll}.deleteMany({})` })
    return id
  }

  const invalidated = (): string[] =>
    queryClient
      .getQueryCache()
      .getAll()
      .filter((q) => q.state.isInvalidated)
      .map((q) => q.queryHash)
      .sort()

  it('never runs a write again: not on invalidation, refetches, tab or mode switches', async () => {
    const a = openShellTab()
    await runWrite(writer(), a)
    const [find] = simpleKeys(a)
    // A shown write observes no query of its own, as in CollectionTab.
    const view = resultView(queryClient, ['idle', a])
    await settle()

    await invalidateWrittenCollection(queryClient, users)
    await queryClient.invalidateQueries()
    await queryClient.refetchQueries()
    view.show(find)
    await settle()
    view.show(['idle', a])
    useTabsStore.getState().openNew(users)
    const b = activeId()
    useTabsStore.getState().setDraft(b, { mode: 'shell', shell: 'db.users.find()' })
    useTabsStore.getState().run(b)
    view.show(shellKey(b))
    await settle()
    useTabsStore.getState().activate(a)
    view.show(['idle', a])
    await invalidateWrittenCollection(queryClient, users)
    await settle()

    expect(write).toHaveBeenCalledTimes(1)
    const [shown] = queryClient.getMutationCache().findAll({ mutationKey: mutationKeys.shellWrite })
    expect(shown?.state).toMatchObject({ status: 'success', variables: { tabId: a } })
    view.unsubscribe()
  })

  it('sends the command to its collection of the tab database', async () => {
    const a = openShellTab()
    await runWrite(writer(), a, deleteAll('orders'))
    expect(write.mock.calls).toEqual([
      [
        {
          connectionId: 'c1',
          db: 'app',
          coll: 'orders',
          op: { method: 'deleteMany', filter: '{}' }
        }
      ]
    ])
  })

  it('refreshes the written collection, its stats and the database collection list', async () => {
    const touched = [
      queryKeys.find('c1', 'app', 'users', '{}', '{}', '{}', 0, 100, 1),
      queryKeys.count('c1', 'app', 'users', '{}', 1),
      queryKeys.collections('c1', 'app'),
      queryKeys.collectionStats('c1', 'app', 'users')
    ]
    const untouched = [
      queryKeys.find('c1', 'app', 'orders', '{}', '{}', '{}', 0, 100, 1),
      queryKeys.collections('c1', 'audit'),
      queryKeys.collectionStats('c1', 'app', 'orders'),
      queryKeys.indexes('c1', 'app', 'users')
    ]
    for (const key of [...touched, ...untouched]) queryClient.setQueryData(key, 'cached')
    await runWrite(writer(), openShellTab())
    expect(invalidated()).toEqual(hashes(touched))
  })

  it('refreshes after a failed write too, since part of it may have been written', async () => {
    write.mockRejectedValue(new ApiError({ code: 'driver_error', message: 'E11000 duplicate key' }))
    const keys = [
      queryKeys.find('c1', 'app', 'users', '{}', '{}', '{}', 0, 100, 1),
      queryKeys.collections('c1', 'app'),
      queryKeys.collectionStats('c1', 'app', 'users')
    ]
    for (const key of keys) queryClient.setQueryData(key, 'cached')
    await expect(runWrite(writer(), openShellTab())).rejects.toThrow('E11000')
    expect(write).toHaveBeenCalledTimes(1)
    expect(invalidated()).toEqual(hashes(keys))
  })

  it('refreshes the $out target in another database, not the source collection', async () => {
    const source = queryKeys.find('c1', 'app', 'users', '{}', '{}', '{}', 0, 100, 1)
    const target = [
      queryKeys.find('c1', 'archive', 'old', '{}', '{}', '{}', 0, 100, 1),
      queryKeys.collections('c1', 'archive'),
      queryKeys.collectionStats('c1', 'archive', 'old')
    ]
    for (const key of [source, ...target]) queryClient.setQueryData(key, 'cached')
    const out: ShellWriteCommand = {
      coll: 'users',
      op: {
        kind: 'write',
        write: { method: 'aggregate', pipeline: '[{"$out":{"db":"archive","coll":"old"}}]' },
        writes: { db: 'archive', coll: 'old' }
      }
    }
    await runWrite(writer(), openShellTab(), out)
    expect(invalidated()).toEqual(hashes(target))
  })

  it("drops a closed tab's write, also while it still runs, and keeps other tabs' writes", async () => {
    const other = openShellTab()
    await runWrite(writer(), other)
    let finish!: (response: WriteResponse) => void
    write.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
    const a = openShellTab()
    const running = runWrite(writer(), a)
    await settle()
    expect(write).toHaveBeenCalledTimes(2)
    expect(writeRuns().map((run) => run.tabId)).toEqual([other, a])

    useTabsStore.getState().close(a)
    expect(writeRuns().map((run) => run.tabId)).toEqual([other])
    finish(WRITTEN)
    await running
    expect(writeRuns().map((run) => run.tabId)).toEqual([other])
  })

  it("a newer shell run of the tab drops the tab's write", async () => {
    const a = openShellTab()
    await runWrite(writer(), a)
    useTabsStore.getState().setDraft(a, { shell: 'db.users.find()' })
    useTabsStore.getState().run(a)
    expect(writeRuns()).toEqual([])
  })

  it('keeps only the latest write when the tab runs writes back to back', async () => {
    const a = openShellTab()
    await runWrite(writer(), a)
    await runWrite(writer(), a)
    expect(write).toHaveBeenCalledTimes(2)
    expect(writeRuns().map((run) => run.epoch)).toEqual([tabOf(a).applied.shell?.epoch])
  })

  it('keeps the write while tabs are activated, paged, renamed or another mode runs', async () => {
    const a = openShellTab()
    await runWrite(writer(), a)
    const before = writeRuns()
    const tabs = useTabsStore.getState()
    tabs.setSkip(a, 100)
    tabs.setDraft(a, { mode: 'simple', filter: '{ a: 1 }' })
    tabs.run(a)
    tabs.setDraft(a, { mode: 'aggregation', pipeline: '[]' })
    tabs.run(a)
    tabs.openNew(users)
    tabs.duplicate(a)
    tabs.activate(a)
    tabs.renameCollection('c1', 'app', 'users', 'members')
    expect(writeRuns()).toEqual(before)
    expect(write).toHaveBeenCalledTimes(1)
  })
})
